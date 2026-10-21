import { rename } from "node:fs/promises";
import { run } from "../util/exec.ts";

const TARGET = "I=-14:TP=-1.5:LRA=11";

export type Loudness = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf("{");
  const end = stderr.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error("loudnorm printed no measurements");
  const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
  const measured = {} as Loudness;
  for (const key of keys) {
    if (typeof raw[key] !== "string") throw new Error(`loudnorm output is missing ${key}`);
    measured[key] = raw[key];
  }
  return measured;
}

export function measuredFilter(m: Loudness): string {
  return (
    `loudnorm=${TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`
  );
}

// A silent mix measures as -inf and cannot be normalised; it is only re-encoded.
export function isMeasurable(m: Loudness): boolean {
  return Number.isFinite(Number(m.input_i));
}

export async function mux(input: string, output: string): Promise<void> {
  const pass1 = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", input, "-vn",
    "-af", `loudnorm=${TARGET}:print_format=json`, "-f", "null", "-",
  ]);
  const measured = parseLoudnorm(pass1.stderr);
  const filter = isMeasurable(measured) ? ["-af", measuredFilter(measured)] : [];
  const part = `${output}.part`;
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
    ...filter,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", part,
  ]);
  await rename(part, output);
}
