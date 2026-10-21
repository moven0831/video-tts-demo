import { Probe, VoiceManifest } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { toSrt, toVtt } from "../timeline/captions.ts";
import { buildTimeline } from "../timeline/timeline.ts";
import { runMain } from "../util/exec.ts";
import { readJson, writeAtomic, writeJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});

  const plan = await readJson(paths.plan, EditPlan);
  const probe = await readJson(paths.probe, Probe);
  const voice = await readJson(paths.voice, VoiceManifest);

  const { timeline, warnings } = buildTimeline(plan, probe, voice);
  await writeJson(paths.timeline, timeline);
  await writeAtomic(paths.captionsSrt, toSrt(timeline.captions));
  await writeAtomic(paths.captionsVtt, toVtt(timeline.captions));

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(`wrote ${paths.timeline} (${timeline.total.toFixed(2)} s)`);
});
