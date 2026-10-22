import { writeHf } from "../compose/write.ts";
import { VFR_WARNING } from "../probe/ffprobe.ts";
import { loadPlan } from "../schema/load.ts";
import { Timeline } from "../timeline/types.ts";
import { runMain } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});

  const timeline = await readJson(paths.timeline, Timeline);
  const { plan, probe, warnings: planWarnings } = await loadPlan(paths);
  const warnings = await writeHf(paths.build, paths.hf, paths.input, timeline, plan, probe);
  if (probe.vfr) console.warn(`warning: ${VFR_WARNING}`);
  for (const warning of [...planWarnings, ...warnings]) console.warn(`warning: ${warning}`);
  console.log(`composed ${paths.hf}`);
});
