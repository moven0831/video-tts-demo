import { z } from "zod";

const sec = z.number().min(0);
const px = z.number().int().min(0);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Box = z.object({ x: px, y: px, w: px.min(1), h: px.min(1) });

const Line = z.object({
  id: slug,
  text: z.string().min(1).max(600),
  at: sec.optional(),
  pauseAfter: sec.default(0.35),
});

const Card = z.object({
  kind: z.enum(["title", "chapter", "outro"]),
  title: z.string().min(1).max(60),
  subtitle: z.string().max(90).optional(),
  sec: sec.default(3),
  narration: z.array(Line).default([]),
});

const Scene = z.object({
  id: slug,
  source: z.object({ in: sec, out: sec }),
  fit: z.enum(["hold", "freeze", "slow", "trim"]).default("freeze"),
  narration: z.array(Line),
  camera: z.array(z.object({ t: sec, box: Box.nullable() })).default([]),
  clicks: z
    .array(
      z.object({
        t: sec,
        x: px,
        y: px,
        kind: z.enum(["click", "double", "drag"]).default("click"),
      }),
    )
    .default([]),
  callouts: z
    .array(
      z.object({
        t0: sec,
        t1: sec,
        box: Box,
        label: z.string().min(1).max(40),
        kind: z.enum(["box", "arrow", "annotate"]).default("box"),
        side: z.enum(["auto", "top", "bottom", "left", "right"]).default("auto"),
      }),
    )
    .default([]),
});

const Chapter = z.object({
  id: slug,
  title: z.string().min(1).max(60),
  card: Card.optional(),
  scenes: z.array(Scene).min(1),
  transition: z
    .object({
      kind: z.enum(["cut", "fade-black", "dissolve", "push"]),
      sec: sec.default(0.5),
    })
    .default({ kind: "cut", sec: 0 }),
});

export const EditPlan = z.object({
  version: z.literal(1),
  meta: z.object({
    project: slug,
    title: z.string().min(1),
    source: z.object({ width: px, height: px, fps: z.number().positive(), duration: sec }),
    output: z.object({ width: z.literal(1920), height: z.literal(1080), fps: z.literal(30) }),
  }),
  style: z.object({
    theme: z.enum(["light", "dark"]).default("dark"),
    accent: hex.default("#6E56CF"),
    font: z.string().default("Inter"),
    captions: z.object({
      mode: z.enum(["burn-in", "off"]).default("burn-in"),
      maxCharsPerLine: z.literal(42).default(42),
      maxLines: z.literal(2).default(2),
    }),
    camera: z.object({
      maxZoom: z.number().min(1).max(3).default(2.4),
      moveSec: sec.default(0.7),
    }),
  }),
  intro: Card.optional(),
  outro: Card.optional(),
  chapters: z.array(Chapter).min(1),
  audio: z.object({
    voice: z.object({ voiceId: z.string().min(1), modelId: z.string().min(1) }),
    music: z.object({
      // A bare filename in the project's music/ dir; no path can reach outside it.
      file: z.string().regex(/^[^/\\.][^/\\]*$/).nullable().default(null),
      prompt: z.string().max(400).optional(),
      gainDb: z.number().default(-18),
      duckDb: z.number().default(-12),
    }),
    sfx: z
      .array(z.object({ scene: slug, t: sec, prompt: z.string().min(1).max(200), sec: sec.max(30) }))
      .default([]),
  }),
});

// Cues are numbered per scene in plan order; voice.json and the timeline both key sfx by this id.
export function sfxCues(plan: EditPlan): (EditPlan["audio"]["sfx"][number] & { id: string })[] {
  const perScene = new Map<string, number>();
  return plan.audio.sfx.map((cue) => {
    const index = perScene.get(cue.scene) ?? 0;
    perScene.set(cue.scene, index + 1);
    return { ...cue, id: `${cue.scene}-${index}` };
  });
}

export const EditPlanDraft = EditPlan.extend({ meta: EditPlan.shape.meta.omit({ source: true }) });

export type EditPlan = z.infer<typeof EditPlan>;
export type EditPlanDraft = z.infer<typeof EditPlanDraft>;
export type Box = z.infer<typeof Box>;
export type Line = z.infer<typeof Line>;
export type Card = z.infer<typeof Card>;
export type Scene = z.infer<typeof Scene>;
export type Chapter = z.infer<typeof Chapter>;
