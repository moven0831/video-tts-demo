import { access, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Timeline } from "../timeline/types.ts";
import { EXIT_NEEDS_SPEND } from "../util/exec.ts";
import { readJson, writeAtomic } from "../util/fs.ts";
import { sha256, sha256File, statKey } from "../util/hash.ts";
import type { ProjectPaths, StageName } from "../util/project.ts";

export type PipelineOptions = { force: boolean; draft: boolean; yes: boolean; plan: boolean };
// Resolves to the stage's exit code; judging a non-zero code is up to the pipeline.
export type Exec = (stage: StageName, args: string[]) => Promise<number>;
type Log = (line: string) => void;

const COMPOSE_SRC = fileURLToPath(new URL("../compose/", import.meta.url));

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat().sort();
}

export async function composeSourceVersion(): Promise<string> {
  const files = (await walk(COMPOSE_SRC)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const parts = await Promise.all(files.map(async (f) => `${relative(COMPOSE_SRC, f)}\n${await readFile(f, "utf8")}`));
  return sha256(parts.join("\0"));
}

export async function treeHash(dir: string): Promise<string> {
  const files = await walk(dir);
  const parts = await Promise.all(
    files.map(async (f) => {
      const rel = relative(dir, f);
      return rel === "assets/input.mp4" ? `${rel}:${await statKey(f)}` : `${rel}:${await sha256File(f)}`;
    }),
  );
  return sha256(parts.join("\n"));
}

async function hashOf(paths: string[]): Promise<string> {
  return sha256((await Promise.all(paths.map(sha256File))).join("\n"));
}

// Stages without `inputs` always run: they manage their own freshness (probe, voice) or are cheap.
type Stage = { name: StageName; inputs?: () => Promise<string>; outputs: string[] };

function stages(p: ProjectPaths, o: PipelineOptions): Stage[] {
  return [
    { name: "probe", outputs: [p.probe] },
    { name: "plan-check", outputs: [] },
    { name: "voice", outputs: [p.voice] },
    {
      name: "timeline",
      inputs: () => hashOf([p.plan, p.probe, p.voice]),
      outputs: [p.timeline, p.captionsSrt, p.captionsVtt],
    },
    {
      name: "compose",
      inputs: async () =>
        sha256(
          [await hashOf([p.timeline, p.plan, p.probe]), await statKey(p.input), await composeSourceVersion()].join("\n"),
        ),
      outputs: [join(p.hf, "index.html")],
    },
    {
      name: "render",
      inputs: async () => sha256(`${await treeHash(p.hf)}\ndraft=${o.draft}`),
      outputs: [p.render],
    },
    {
      name: "mux",
      inputs: () => hashOf([p.render, p.captionsSrt, p.captionsVtt]),
      outputs: [p.final, p.finalSrt, p.finalVtt, p.finalContact],
    },
  ];
}

function stageArgs(name: StageName, o: PipelineOptions): string[] {
  if (name === "voice" && o.yes) return ["--yes"];
  if (name === "render" && o.draft) return ["--draft"];
  return [];
}

async function execStage(exec: Exec, stage: StageName, args: string[]): Promise<void> {
  const code = await exec(stage, args);
  if (code === EXIT_NEEDS_SPEND) {
    throw new Error(`${stage} needs to spend; review the estimate above and rerun with --yes`);
  }
  if (code !== 0) throw new Error(`${stage} exited with code ${code}`);
}

// What a stage consumed and wrote. Outputs are stat keys, so a render redone by hand (say a
// --draft one) no longer matches and the next demo run redoes the stage.
const Saved = z.object({ inputs: z.string(), outputs: z.record(z.string(), z.string()) });
type Saved = z.infer<typeof Saved>;

async function readSaved(file: string): Promise<Saved | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  try {
    const saved = Saved.safeParse(JSON.parse(text));
    return saved.success ? saved.data : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

type Outputs = { keys: Record<string, string> } | { missing: string };

async function outputKeys(p: ProjectPaths, outputs: string[]): Promise<Outputs> {
  const keys: Record<string, string> = {};
  for (const output of outputs) {
    try {
      keys[relative(p.root, output)] = await statKey(output);
    } catch (err) {
      if (isMissing(err)) return { missing: relative(p.root, output) };
      throw err;
    }
  }
  return { keys };
}

async function currentInputs(stage: Stage): Promise<string | null> {
  try {
    return stage.inputs ? await stage.inputs() : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function staleReason(saved: Saved | null, inputs: string | null, current: Outputs): string | null {
  if (inputs === null) return "an input file is missing";
  if (saved === null) return "no record of a previous run";
  if (saved.inputs !== inputs) return "inputs changed";
  if ("missing" in current) return `${current.missing} is missing`;
  const changed = Object.entries(current.keys).find(([file, key]) => saved.outputs[file] !== key);
  return changed ? `${changed[0]} changed since the stage wrote it` : null;
}

async function runStage(
  p: ProjectPaths,
  o: PipelineOptions,
  stage: Stage,
  exec: Exec,
  log: Log,
): Promise<void> {
  const hashFile = p.demoHash(stage.name);
  let inputs: string | null = null;
  if (stage.inputs) {
    inputs = await currentInputs(stage);
    const reason = o.force
      ? "--force"
      : staleReason(await readSaved(hashFile), inputs, await outputKeys(p, stage.outputs));
    if (reason === null) {
      log(`skip ${stage.name} (unchanged)`);
      return;
    }
    log(`run ${stage.name} (${reason})`);
    // A failed run must not leave the record of an earlier one behind.
    await rm(hashFile, { force: true });
  } else {
    log(`run ${stage.name}`);
  }
  await execStage(exec, stage.name, stageArgs(stage.name, o));
  if (!stage.inputs) return;
  // No stage's inputs include its own outputs, so the pre-exec value is what the stage consumed.
  const written = await outputKeys(p, stage.outputs);
  if ("missing" in written) throw new Error(`${stage.name} finished without writing ${written.missing}`);
  const saved: Saved = { inputs: inputs ?? (await stage.inputs()), outputs: written.keys };
  await writeAtomic(hashFile, JSON.stringify(saved));
}

async function logWarnings(p: ProjectPaths, log: Log): Promise<void> {
  const { warnings = [] } = await readJson(p.timeline, Timeline);
  if (warnings.length === 0) return;
  log("warnings:");
  for (const warning of warnings) log(`  ${warning}`);
}

export async function runPipeline(
  p: ProjectPaths,
  o: PipelineOptions,
  exec: Exec,
  log: Log = console.log,
): Promise<void> {
  const [probe, ...rest] = stages(p, o);
  const hasPlan = await exists(p.plan);
  if (!hasPlan && !o.plan) {
    throw new Error(`${p.plan} is missing; write it or pass --plan to generate it`);
  }
  if (hasPlan && o.plan) {
    log("edit-plan.json exists; --plan ignored (use npm run plan -- <name> --force)");
  }
  await runStage(p, o, probe, exec, log);
  if (!(await exists(p.plan))) await execStage(exec, "plan", o.yes ? ["--yes"] : []);
  for (const stage of rest) await runStage(p, o, stage, exec, log);
  await logWarnings(p, log);
}
