import { z } from "zod";
import { Box } from "./edit-plan.ts";

const sec = z.number().min(0);

export const Probe = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration: sec,
  colorSpace: z.string().optional(),
  // Frames in the video stream; the format duration can run past the last video frame.
  frames: z.number().int().positive().optional(),
  // r_frame_rate and avg_frame_rate disagree, so frame index and time do not line up.
  vfr: z.literal(true).optional(),
});

export const SceneCuts = z.array(z.object({ t: sec, score: z.number() }));

// boxes[i] bounds what changed between the 1 fps samples at seconds i-1 and i, in source pixels.
// It is null at i=0 and when under 0.2% of the pixels changed.
export const Motion = z.object({
  boxes: z.array(z.object({ t: sec, box: Box.nullable() })),
  idle: z.array(z.object({ t0: sec, t1: sec })),
});

export const Word = z.object({ text: z.string(), start: sec, end: sec });

// File paths are relative to the project's build/ dir.
export const VoiceManifest = z.object({
  lines: z.record(z.string(), z.object({ file: z.string(), duration: sec, words: z.array(Word) })),
  sfx: z.record(z.string(), z.object({ file: z.string(), duration: sec })),
  music: z.object({ file: z.string(), duration: sec }).optional(),
});

export type Probe = z.infer<typeof Probe>;
export type SceneCuts = z.infer<typeof SceneCuts>;
export type Motion = z.infer<typeof Motion>;
export type Word = z.infer<typeof Word>;
export type VoiceManifest = z.infer<typeof VoiceManifest>;
