import type { Probe } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { splitSegments } from "../voice/clips.ts";

export function skeletonFromNarration(
  text: string,
  probe: Probe,
  opts: { project: string; title: string; voiceId: string; modelId: string },
): EditPlan {
  const segments = splitSegments(text);
  const starts = segments.map(
    (segment, i) => segment.at ?? Math.round((probe.duration * i * 1000) / segments.length) / 1000,
  );
  return EditPlan.parse({
    version: 1,
    meta: {
      project: opts.project,
      title: opts.title,
      source: {
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        duration: probe.duration,
      },
      output: { width: 1920, height: 1080, fps: 30 },
    },
    style: { captions: {}, camera: {} },
    chapters: [
      {
        id: "main",
        title: opts.title,
        scenes: segments.map((segment, i) => ({
          id: `s${i + 1}`,
          source: { in: starts[i], out: starts[i + 1] ?? probe.duration },
          narration: [{ id: `s${i + 1}-l1`, text: segment.text.replace(/\s*\n\s*/g, " ") }],
        })),
      },
    ],
    audio: { voice: { voiceId: opts.voiceId, modelId: opts.modelId }, music: {} },
  });
}
