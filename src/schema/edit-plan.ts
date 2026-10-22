import { z } from "zod";

// Each field gets its own instance. The structured-output transform keeps only the $ref of a
// reused instance, which would drop a bound or default added on top of it.
const sourceSec = () => z.number().min(0).describe("seconds of the source recording");
const durationSec = () => z.number().min(0);
const sourcePx = () => z.number().int().min(0).describe("source pixels");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Box = z.object({
  x: sourcePx(),
  y: sourcePx(),
  w: sourcePx().min(1),
  h: sourcePx().min(1),
});

export const ClickKind = z.enum(["click", "double", "drag"]);
export const CalloutKind = z.enum(["box", "arrow", "annotate"]);
export const CalloutSide = z.enum(["auto", "top", "bottom", "left", "right"]);
export const CardKind = z.enum(["title", "chapter", "outro"]);
export const TransitionKind = z.enum(["cut", "fade-black", "dissolve", "push"]);

const Line = z.object({
  id: slug,
  text: z.string().min(1).max(600),
  at: sourceSec().optional(),
  pauseAfter: durationSec().describe("seconds of silence after the line, in the output").default(0.35),
});

const Card = z.object({
  kind: CardKind,
  title: z.string().min(1).max(60),
  subtitle: z.string().max(90).optional(),
  sec: durationSec().describe("seconds the card is shown, in the output").default(3),
  narration: z.array(Line).default([]),
});

const Scene = z.object({
  id: slug,
  source: z.object({ in: sourceSec(), out: sourceSec() }),
  fit: z.enum(["hold", "freeze", "slow", "trim"]).default("freeze"),
  narration: z.array(Line),
  camera: z.array(z.object({ t: sourceSec(), box: Box.nullable() })).default([]),
  clicks: z
    .array(
      z.object({
        t: sourceSec(),
        x: sourcePx(),
        y: sourcePx(),
        kind: ClickKind.default("click"),
      }),
    )
    .default([]),
  callouts: z
    .array(
      z.object({
        t0: sourceSec(),
        t1: sourceSec(),
        box: Box,
        label: z.string().min(1).max(40),
        kind: CalloutKind.default("box"),
        side: CalloutSide.default("auto"),
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
      kind: TransitionKind,
      sec: durationSec().describe("seconds the transition takes, in the output").default(0.5),
    })
    .default({ kind: "cut", sec: 0 }),
});

export const EditPlan = z.object({
  version: z.literal(1),
  meta: z.object({
    project: slug,
    title: z.string().min(1),
    source: z.object({
      width: sourcePx(),
      height: sourcePx(),
      fps: z.number().positive(),
      duration: sourceSec(),
    }),
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
      moveSec: durationSec().describe("seconds a camera move takes, in the output").default(0.7),
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
      duckDb: z.number().max(0).default(-12),
    }),
    sfx: z
      .array(
        z.object({
          scene: slug,
          t: sourceSec(),
          prompt: z.string().min(1).max(200),
          sec: z.number().min(0.5).max(30).describe("seconds of sound effect"),
        }),
      )
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
