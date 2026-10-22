import { readJson } from "../util/fs.ts";
import type { projectPaths } from "../util/project.ts";
import { Probe } from "./artifacts.ts";
import { EditPlan } from "./edit-plan.ts";
import { validatePlan } from "./validate.ts";

type Paths = Pick<ReturnType<typeof projectPaths>, "plan" | "probe">;

export async function loadPlan(
  paths: Paths,
): Promise<{ plan: EditPlan; probe: Probe; warnings: string[] }> {
  const plan = await readJson(paths.plan, EditPlan);
  const probe = await readJson(paths.probe, Probe);
  const { errors, warnings } = validatePlan(plan, probe);
  if (errors.length > 0) throw new Error(`${paths.plan}:\n${errors.join("\n")}`);
  return { plan, probe, warnings };
}
