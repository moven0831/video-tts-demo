import { z } from "zod";
import {
  CalloutKind,
  CalloutSide,
  CardKind,
  ClickKind,
  TransitionKind,
} from "../schema/edit-plan.ts";

const sec = z.number().min(0);
const StageBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

// Narration, sfx and music `file` paths are relative to the project's build/ dir. Click and callout
// geometry is stage pixels before the camera transform (compose puts both inside the camera layer);
// camera x/y/scale are that transform. Times are output seconds, except segment `in`, `out` and
// `freeze.at`, which are source seconds. A segment spans its video part plus its freeze: the video
// plays source in..out at `rate` from `start`, then the freeze-frame image shows from freeze.start
// to end. `freeze.at` is the source time of the last frame the video part shows; see grid.ts.
export const Timeline = z.object({
  total: sec,
  stage: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  fit: z.object({ scale: z.number().positive(), x: z.number(), y: z.number() }),
  segments: z.array(
    z.object({
      scene: z.string(),
      start: sec,
      end: sec,
      in: sec,
      out: sec,
      rate: z.number().positive(),
      freeze: z.object({ at: sec, start: sec, duration: sec }).optional(),
    }),
  ),
  camera: z.array(
    z.object({
      t: sec,
      scale: z.number().min(1),
      x: z.number(),
      y: z.number(),
      duration: sec,
      ease: z.string(),
    }),
  ),
  clicks: z.array(
    z.object({ t: sec, x: z.number(), y: z.number(), kind: ClickKind }),
  ),
  callouts: z.array(
    z.object({
      box: StageBox,
      label: z.string(),
      kind: CalloutKind,
      side: CalloutSide,
      t0: sec,
      t1: sec,
    }),
  ),
  cards: z.array(
    z.object({
      id: z.string(),
      kind: CardKind,
      title: z.string(),
      subtitle: z.string().optional(),
      start: sec,
      duration: sec,
    }),
  ),
  transitions: z.array(
    z.object({
      kind: TransitionKind,
      start: sec,
      duration: sec,
    }),
  ),
  narration: z.array(
    z.object({ lineId: z.string(), file: z.string(), start: sec, duration: sec }),
  ),
  captions: z.array(z.object({ start: sec, end: sec, lines: z.array(z.string()) })),
  sfx: z.array(z.object({ id: z.string(), file: z.string(), start: sec, duration: sec })),
  music: z
    .object({
      file: z.string(),
      gainDb: z.number(),
      lane: z.array(z.object({ t: sec, db: z.number() })),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
});

export type Timeline = z.infer<typeof Timeline>;
