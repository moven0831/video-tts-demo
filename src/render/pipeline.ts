import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, sha256File } from "../util/hash.ts";
import { writeAtomic } from "../util/fs.ts";
import type { projectPaths } from "../util/project.ts";

type Paths = ReturnType<typeof projectPaths>;

export type PipelineOptions = { force: boolean; draft: boolean; yes: boolean; plan: boolean };
export type Exec = (stage: string, args: string[]) => Promise<void>;

const COMPOSE_SRC = fileURLToPath(new URL("../compose/", import.meta.url));

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat().sort();
}

// Recordings run to gigabytes; size and mtime identify them well enough.
async function statKey(path: string): Promise<string> {
  const s = await stat(path);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
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
type Stage = { name: string; inputs?: () => Promise<string>; outputs: string[] };

function stages(p: Paths, o: PipelineOptions): Stage[] {
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
          [await hashOf([p.timeline, p.plan]), await statKey(p.input), await composeSourceVersion()].join("\n"),
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

function stageArgs(name: string, o: PipelineOptions): string[] {
  if (name === "voice" && o.yes) return ["--yes"];
  if (name === "render" && o.draft) return ["--draft"];
  return [];
}

async function voiceReady(p: Paths): Promise<boolean> {
  if (!(await exists(p.voice))) return false;
  return (await stat(p.voice)).mtimeMs >= (await stat(p.plan)).mtimeMs;
}

async function runStage(p: Paths, o: PipelineOptions, stage: Stage, exec: Exec): Promise<void> {
  const hashFile = p.demoHash(stage.name);
  if (stage.inputs) {
    const outputsExist = (await Promise.all(stage.outputs.map(exists))).every(Boolean);
    const inputs = await stage.inputs().catch(() => null);
    const previous = await readFile(hashFile, "utf8").catch(() => null);
    if (!o.force && inputs !== null && outputsExist && previous === inputs) {
      console.log(`skip ${stage.name} (unchanged)`);
      return;
    }
  }
  console.log(`run ${stage.name}`);
  await exec(stage.name, stageArgs(stage.name, o));
  if (stage.name === "voice" && !o.yes && !(await voiceReady(p))) {
    throw new Error("voice has not been generated; review the spend above and rerun with --yes");
  }
  if (stage.inputs) await writeAtomic(hashFile, await stage.inputs());
}

export async function runPipeline(p: Paths, o: PipelineOptions, exec: Exec): Promise<void> {
  const [probe, ...rest] = stages(p, o);
  if (!(await exists(p.plan)) && !o.plan) {
    throw new Error(`${p.plan} is missing; write it or pass --plan to generate it`);
  }
  await runStage(p, o, probe, exec);
  if (!(await exists(p.plan))) await exec("plan", ["--yes"]);
  for (const stage of rest) await runStage(p, o, stage, exec);
}
