import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EditPlan } from "../schema/edit-plan.ts";
import type { Timeline } from "../timeline/types.ts";
import type { Probe } from "../schema/artifacts.ts";
import { colorMatrix } from "../probe/frames.ts";
import { run } from "../util/exec.ts";
import { writeAtomic } from "../util/fs.ts";
import { compose } from "./compose.ts";

// `at` is the source time of the last frame the video plays, so the still continues it unseen.
export function stillFrame(at: number, fps: number, duration: number, frames?: number): number {
  return Math.min(Math.round(at * fps), (frames ?? Math.round(duration * fps)) - 1);
}

export function stillIndex(at: number, probe: Probe): number {
  return stillFrame(at, probe.fps, probe.duration, probe.frames);
}

// ffmpeg exits 0 and writes nothing when the select expression matches no frame.
export async function writeStill(
  input: string,
  to: string,
  index: number,
  matrix: string,
  label: { scene: string; at: number },
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", input,
    "-vf", `select=eq(n\\,${index}),scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}`,
    "-fps_mode", "passthrough", "-frames:v", "1", to,
  ]);
  const size = await stat(to).then((s) => s.size, () => 0);
  if (size === 0) {
    throw new Error(
      `could not extract the freeze frame for scene "${label.scene}" at ${label.at} s ` +
        `(frame ${index}); the recording may have a variable frame rate or fewer frames than probed`,
    );
  }
}

async function place(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

export async function writeHf(
  build: string,
  hf: string,
  input: string,
  timeline: Timeline,
  plan: EditPlan,
  probe: Probe,
): Promise<string[]> {
  const result = compose(timeline, plan);
  await rm(hf, { recursive: true, force: true });
  for (const [path, text] of Object.entries(result.files)) await writeAtomic(join(hf, path), text);
  for (const { from, to } of result.copies) {
    const src = isAbsolute(from) ? from : resolve(build, from);
    await place(src, join(hf, to));
  }
  const matrix = colorMatrix(probe.colorSpace);
  for (const still of result.stills) {
    await writeStill(input, join(hf, still.to), stillIndex(still.at, probe), matrix, still);
  }
  return result.warnings;
}
