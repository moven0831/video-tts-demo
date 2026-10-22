import { rename } from "node:fs/promises";
import type { Timeline } from "../timeline/types.ts";
import { run } from "../util/exec.ts";

const TARGET = "I=-14:TP=-1.5:LRA=11";
const KEYS = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
const SNIPPET_CHARS = 200;

export type Loudness = Record<(typeof KEYS)[number], string>;

export function audioClipCount(timeline: Timeline): number {
  return timeline.narration.length + timeline.sfx.length + (timeline.music ? 1 : 0);
}

export function parseLoudnorm(stderr: string): Loudness {
  const start = stderr.lastIndexOf("{");
  const end = stderr.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error("loudnorm printed no measurements");
  const block = stderr.slice(start, end + 1);
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(block);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error(`loudnorm printed measurements that are not JSON: ${block.slice(0, SNIPPET_CHARS)}`, {
      cause: err,
    });
  }
  const measured = {} as Loudness;
  for (const key of KEYS) {
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

// A silent mix measures as -inf integrated loudness.
export function isSilent(m: Loudness): boolean {
  return !Number.isFinite(Number(m.input_i));
}

// Any -inf field would make the measured filter invalid, so the track is only re-encoded.
export function isMeasurable(m: Loudness): boolean {
  return KEYS.every((key) => Number.isFinite(Number(m[key])));
}

// Silence is only fine when the timeline has nothing to play.
export function assertAudible(m: Loudness, audioClips: number): void {
  if (audioClips > 0 && isSilent(m)) {
    throw new Error(
      `render produced a silent audio track although the timeline has ${audioClips} audio clips`,
    );
  }
}

export async function mux(input: string, output: string, audioClips: number): Promise<void> {
  const pass1 = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", input, "-vn",
    "-af", `loudnorm=${TARGET}:print_format=json`, "-f", "null", "-",
  ]);
  const measured = parseLoudnorm(pass1.stderr);
  assertAudible(measured, audioClips);
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
