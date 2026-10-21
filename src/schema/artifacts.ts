import { z } from "zod";
import { Box } from "./edit-plan.ts";

const sec = z.number().min(0);

export const Probe = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration: sec,
  colorSpace: z.string().optional(),
});

export const SceneCuts = z.array(z.object({ t: sec, score: z.number() }));

// boxes[i] covers second i of the source; null means nothing changed. All in source pixels.
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
