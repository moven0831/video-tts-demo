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
import { EXIT_NEEDS_SPEND, runMain } from "../util/exec.ts";
import { readJson, writeJson } from "../util/fs.ts";
import { parseProjectArgs, type ProjectPaths } from "../util/project.ts";

export async function runPlan(
  paths: ProjectPaths,
  client: PlanClient,
  opts: { yes: boolean; force: boolean },
  log: (line: string) => void = console.log,
): Promise<"written" | "needs-spend"> {
  const index = paths.sheetsIndex;
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
    sheets: await loadSheets(index, paths.build),
  };
  const cacheDir = paths.cacheDir("plan");
  const params = buildPlanRequest(input);

  if (!opts.yes && !existsSync(planCachePath(params, cacheDir))) {
    const est = estimateRequest(params, input.sheets.sizes);
    log(`${est.images} sheets, about ${est.inputTokens} input tokens`);
    log(`estimated cost $${est.low.toFixed(2)} to $${est.high.toFixed(2)}`);
    if (input.brief === undefined) log("no brief.md; the director gets no brief");
    log("frames are sent to the Anthropic API; rerun with --yes to spend");
    return "needs-spend";
  }

  const { plan, warnings, usage } = await makePlan(client, input, {
    cacheDir,
    rejectedPath: paths.planRejected,
  });
  await writeJson(paths.plan, plan);
  for (const warning of warnings) log(`warning: ${warning}`);
  log(usage ? `used ${formatUsage(usage)}` : "plan came from the cache");
  log(`wrote ${paths.plan}`);
  return "written";
}

export async function runPlanFromNarration(
  paths: ProjectPaths,
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
  const words = paths.name.replace(/[-_]+/g, " ").trim();
  const project =
    paths.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "demo";
  const { plan, warnings } = skeletonFromNarration(text, await readJson(paths.probe, Probe), {
    project,
    title: words === "" ? "Demo" : words.charAt(0).toUpperCase() + words.slice(1),
    voiceId: "default",
    modelId: "default",
  });
  await writeJson(paths.plan, plan);
  for (const warning of warnings) log(`warning: ${warning}`);
  log(`wrote ${paths.plan}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMain(async () => {
    const { paths, values } = parseProjectArgs(process.argv.slice(2), {
      yes: { type: "boolean" },
      force: { type: "boolean" },
      "from-narration": { type: "string" },
    });
    if (values["from-narration"] !== undefined) {
      const text = await readFile(values["from-narration"], "utf8");
      await runPlanFromNarration(paths, text, { force: !!values.force });
    } else {
      const outcome = await runPlan(paths, new Anthropic(), {
        yes: !!values.yes,
        force: !!values.force,
      });
      if (outcome === "needs-spend") process.exitCode = EXIT_NEEDS_SPEND;
    }
  });
}
