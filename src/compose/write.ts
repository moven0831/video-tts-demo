import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EditPlan } from "../schema/edit-plan.ts";
import type { Timeline } from "../timeline/types.ts";
import { run } from "../util/exec.ts";
import { writeAtomic } from "../util/fs.ts";
import { compose } from "./compose.ts";

const MATRIX: Record<string, string> = {
  smpte170m: "bt601",
  bt470bg: "bt601",
  bt2020nc: "bt2020",
};

// The last played frame, so the still continues the video without a visible step.
export function stillFrame(at: number, fps: number, duration: number): number {
  const last = Math.round(duration * fps) - 1;
  return Math.min(Math.max(Math.ceil(at * fps - 1e-6) - 1, 0), last);
}

async function colorMatrix(input: string): Promise<string> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=color_space", "-of", "csv=p=0", input,
  ]);
  return MATRIX[stdout.trim()] ?? "bt709";
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
): Promise<string[]> {
  const result = compose(timeline, plan);
  await rm(hf, { recursive: true, force: true });
  for (const [path, text] of Object.entries(result.files)) await writeAtomic(join(hf, path), text);
  for (const { from, to } of result.copies) {
    const src = isAbsolute(from) ? from : resolve(build, from);
    await place(src, join(hf, to));
  }
  const matrix = await colorMatrix(input);
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
