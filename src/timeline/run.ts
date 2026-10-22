import { VFR_WARNING } from "../probe/ffprobe.ts";
import { VoiceManifest } from "../schema/artifacts.ts";
import { loadPlan } from "../schema/load.ts";
import { readJson, writeAtomic, writeJson } from "../util/fs.ts";
import type { ProjectPaths } from "../util/project.ts";
import { staleVoice } from "../voice/keys.ts";
import { toSrt, toVtt } from "./captions.ts";
import { buildTimeline } from "./timeline.ts";
import type { Timeline } from "./types.ts";

export async function runTimeline(
  paths: ProjectPaths,
  env: Record<string, string | undefined>,
  warn: (line: string) => void = console.warn,
): Promise<Timeline> {
  const { plan, probe, warnings: planWarnings } = await loadPlan(paths);
  const voice = await readJson(paths.voice, VoiceManifest);
  const stale = staleVoice(plan, voice, env);
  if (stale.length > 0) {
    throw new Error(`${stale.join("\n")}\nrun npm run voice -- ${paths.name} --yes`);
  }

  const { timeline, warnings } = buildTimeline(plan, probe, voice);
  await writeJson(paths.timeline, timeline);
  await writeAtomic(paths.captionsSrt, toSrt(timeline.captions));
  await writeAtomic(paths.captionsVtt, toVtt(timeline.captions));

  if (probe.vfr) warn(`warning: ${VFR_WARNING}`);
  for (const warning of [...planWarnings, ...warnings]) warn(`warning: ${warning}`);
  return timeline;
}
