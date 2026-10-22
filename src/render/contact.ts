import { rename } from "node:fs/promises";
import { run } from "../util/exec.ts";

const COLS = 6;
const MAX_TILES = 30;

// One tile per 5 s, capped at 30 tiles (longer videos space them wider); videos under 30 s get one
// row of 6 so the sheet is never one frame.
export function contactLayout(duration: number): { interval: number; cols: number; rows: number } {
  const interval = Math.max(Math.min(5, duration / COLS), duration / MAX_TILES, 0.1);
  const tiles = Math.min(MAX_TILES, Math.max(1, Math.ceil(duration / interval)));
  return { interval, cols: COLS, rows: Math.ceil(tiles / COLS) };
}

export async function contactSheet(video: string, output: string): Promise<void> {
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video,
  ]);
  const { interval, cols, rows } = contactLayout(Number(probe.stdout.trim()));
  const part = `${output}.part.jpg`;
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", video,
    "-vf", `fps=1/${interval},scale=320:-1,tile=${cols}x${rows}`,
    "-frames:v", "1", "-q:v", "3", part,
  ]);
  await rename(part, output);
}
