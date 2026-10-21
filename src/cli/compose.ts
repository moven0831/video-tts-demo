import { Probe } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { writeHf } from "../compose/write.ts";
import { Timeline } from "../timeline/types.ts";
import { runMain } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});

  const timeline = await readJson(paths.timeline, Timeline);
  const plan = await readJson(paths.plan, EditPlan);
  const probe = await readJson(paths.probe, Probe);
  const warnings = await writeHf(paths.build, paths.hf, paths.input, timeline, plan, probe);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(`composed ${paths.hf}`);
});
