import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSheets } from "../director/images.ts";
import {
  estimateRequest,
  formatUsage,
  makePlan,
  planCachePath,
  type PlanClient,
} from "../director/plan.ts";
import { buildPlanRequest } from "../director/prompt.ts";
import { skeletonFromNarration } from "../director/skeleton.ts";
import { Motion, Probe, SceneCuts } from "../schema/artifacts.ts";
import { readJson, writeAtomic } from "../util/fs.ts";
import { parseProjectArgs, projectPaths } from "../util/project.ts";

type Paths = ReturnType<typeof projectPaths>;

export async function runPlan(
  paths: Paths,
  client: PlanClient,
  opts: { yes: boolean; force: boolean },
  log: (line: string) => void = console.log,
): Promise<void> {
  const index = `${paths.sheets}/index.json`;
  for (const file of [paths.probe, paths.scenes, paths.motion, index]) {
    if (!existsSync(file)) {
      throw new Error(`${file} is missing; run \`npm run probe -- ${paths.name}\` first`);
    }
  }
  if (existsSync(paths.plan) && !opts.force) {
    throw new Error(`${paths.plan} exists and may hold hand edits; pass --force to overwrite it`);
  }

  const input = {
    probe: await readJson(paths.probe, Probe),
    scenes: await readJson(paths.scenes, SceneCuts),
    motion: await readJson(paths.motion, Motion),
    brief: existsSync(paths.brief) ? await readFile(paths.brief, "utf8") : undefined,
    sheets: await loadSheets(paths.sheets),
  };
  const cacheDir = paths.cacheDir("plan");
  const params = buildPlanRequest(input);

  if (!opts.yes && !existsSync(planCachePath(params, cacheDir))) {
    const est = estimateRequest(params, input.sheets.sizes);
    log(`${est.images} sheets, about ${est.inputTokens} input tokens`);
    log(`estimated cost $${est.low.toFixed(2)} to $${est.high.toFixed(2)}`);
    log("frames are sent to the Anthropic API; rerun with --yes to spend");
    return;
  }

  const { plan, warnings, usage } = await makePlan(client, input, { cacheDir });
  await writeAtomic(paths.plan, `${JSON.stringify(plan, null, 2)}\n`);
  for (const warning of warnings) log(`warning: ${warning}`);
  log(usage ? `used ${formatUsage(usage)}` : "plan came from the cache");
  log(`wrote ${paths.plan}`);
}

export async function runPlanFromNarration(
  paths: Paths,
  text: string,
  opts: { force: boolean },
  log: (line: string) => void = console.log,
): Promise<void> {
  if (!existsSync(paths.probe)) {
    throw new Error(`${paths.probe} is missing; run \`npm run probe -- ${paths.name}\` first`);
  }
  if (existsSync(paths.plan) && !opts.force) {
    throw new Error(`${paths.plan} exists and may hold hand edits; pass --force to overwrite it`);
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const plan = skeletonFromNarration(text, await readJson(paths.probe, Probe), {
    project: paths.name,
    title: firstLine?.trim().slice(0, 60) || paths.name,
    voiceId: "default",
    modelId: "default",
  });
  await writeAtomic(paths.plan, `${JSON.stringify(plan, null, 2)}\n`);
  log(`wrote ${paths.plan}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { paths, values } = parseProjectArgs(process.argv.slice(2), {
    yes: { type: "boolean" },
    force: { type: "boolean" },
    "from-narration": { type: "string" },
  });
  if (values["from-narration"] !== undefined) {
    const text = await readFile(values["from-narration"], "utf8");
    await runPlanFromNarration(paths, text, { force: !!values.force });
  } else {
    await runPlan(paths, new Anthropic(), { yes: !!values.yes, force: !!values.force });
  }
}
