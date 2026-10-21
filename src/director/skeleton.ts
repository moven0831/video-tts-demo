import type { Probe } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { splitSegments, type Segment } from "../voice/clips.ts";

function clock(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

// Timestamps at or past the end, or not rising, count as missing. Missing starts are spread
// across the gap between the neighbouring valid starts, so every scene keeps in < out.
function resolveStarts(segments: Segment[], duration: number) {
  const warnings: string[] = [];
  const starts: (number | undefined)[] = [];
  let last = -1;
  for (const [i, { at }] of segments.entries()) {
    if (at !== undefined && at < duration && at > last && (i === 0 || at > 0)) {
      starts.push(at);
      last = at;
    } else {
      if (at !== undefined) {
        warnings.push(`block ${i + 1}: ignored timestamp ${clock(at)}, not inside the recording`);
      }
      starts.push(undefined);
    }
  }
  for (let i = 0; i < starts.length; ) {
    if (starts[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < starts.length && starts[j] === undefined) j++;
    const left = i === 0 ? 0 : (starts[i - 1] as number);
    const right = j === starts.length ? duration : (starts[j] as number);
    const count = j - i;
    for (let k = 0; k < count; k++) {
      const step = i === 0 ? k : k + 1;
      const share = i === 0 ? count : count + 1;
      starts[i + k] = Math.round((left + ((right - left) * step) / share) * 1000) / 1000;
    }
    i = j;
  }
  return { starts: starts as number[], warnings };
}

export function skeletonFromNarration(
  text: string,
  probe: Probe,
  opts: { project: string; title: string; voiceId: string; modelId: string },
): { plan: EditPlan; warnings: string[] } {
  const segments = splitSegments(text);
  if (segments.length > Math.floor(probe.duration)) {
    throw new Error(
      `${segments.length} narration blocks do not fit in ${probe.duration}s of video; ` +
        "shorten the narration or use a longer recording",
    );
  }
  const { starts, warnings } = resolveStarts(segments, probe.duration);
  const plan = EditPlan.parse({
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
        title: "Walkthrough",
        scenes: segments.map((segment, i) => ({
          id: `s${i + 1}`,
          source: { in: starts[i], out: starts[i + 1] ?? probe.duration },
          narration: [{ id: `s${i + 1}-l1`, text: segment.text.replace(/\s*\n\s*/g, " ") }],
        })),
      },
    ],
    audio: { voice: { voiceId: opts.voiceId, modelId: opts.modelId }, music: {} },
  });
  return { plan, warnings };
}
