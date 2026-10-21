import { readFileSync } from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Motion, Probe, SceneCuts } from "../schema/artifacts.ts";
import { EditPlanDraft } from "../schema/edit-plan.ts";
import { stableStringify } from "../util/hash.ts";
import type { Sheets } from "./images.ts";

export type PlanInput = {
  probe: Probe;
  scenes: SceneCuts;
  motion: Motion;
  brief?: string;
  sheets: Sheets;
};

type Env = Record<string, string | undefined>;

const DIRECTOR = readFileSync(new URL("./DIRECTOR.md", import.meta.url), "utf8");
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

function motionSummary(motion: Motion): string {
  const rows = motion.boxes.flatMap(({ t, box }) =>
    box ? [`${t}: ${box.x},${box.y},${box.w},${box.h}`] : [],
  );
  const idle = motion.idle.map(({ t0, t1 }) => `${t0}-${t1}`).join(", ");
  return [
    "Motion, source pixels. Per second: changed region as x,y,w,h (seconds with no change omitted).",
    ...rows,
    `Idle spans: ${idle || "none"}`,
  ].join("\n");
}

export function buildPlanRequest(
  input: PlanInput,
  env: Env = process.env,
): BetaMessageStreamParams {
  const { probe, scenes, motion, brief, sheets } = input;
  const context = [
    `Probe: ${stableStringify(probe)}`,
    `Scene cuts: ${stableStringify(scenes)}`,
    motionSummary(motion),
    brief ? `Brief:\n${brief}` : "Brief: none",
    `The ${sheets.sizes.length} contact sheets follow, each after its label.`,
  ].join("\n\n");
  const finish =
    `Write the edit plan for this ${probe.width}x${probe.height} recording of ` +
    `${probe.duration} seconds. Follow the director brief and return only the plan JSON.`;

  return {
    model: env.DEMO_MODEL ?? "claude-opus-5-5",
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: Effort.parse(env.DEMO_EFFORT ?? "high"),
      format: zodOutputFormat(EditPlanDraft),
    },
    system: DIRECTOR,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: context },
          ...sheets.content,
          { type: "text", text: finish },
        ],
      },
    ],
  };
}
