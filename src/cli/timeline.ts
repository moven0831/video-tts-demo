import { runTimeline } from "../timeline/run.ts";
import { runMain } from "../util/exec.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});

  const timeline = await runTimeline(paths, process.env);
  console.log(`wrote ${paths.timeline} (${timeline.total.toFixed(2)} s)`);
});
