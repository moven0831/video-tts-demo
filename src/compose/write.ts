import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EditPlan } from "../schema/edit-plan.ts";
import type { Timeline } from "../timeline/types.ts";
import type { Probe } from "../schema/artifacts.ts";
import { colorMatrix } from "../probe/frames.ts";
import { run } from "../util/exec.ts";
import { writeAtomic } from "../util/fs.ts";
import { compose } from "./compose.ts";

// `at` is the source time of the last frame the video plays, so the still continues it unseen.
export function stillFrame(at: number, fps: number, duration: number): number {
  return Math.min(Math.round(at * fps), Math.round(duration * fps) - 1);
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
  const { fps, duration } = plan.meta.source;
  for (const still of result.stills) {
    const n = stillFrame(still.at, fps, duration);
    await mkdir(dirname(join(hf, still.to)), { recursive: true });
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", input,
      "-vf", `select=eq(n\\,${n}),scale=in_color_matrix=${matrix}:out_color_matrix=${matrix}`,
      "-fps_mode", "passthrough", "-frames:v", "1", join(hf, still.to),
    ]);
  }
  return result.warnings;
}
