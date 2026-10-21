import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { EditPlan, EditPlanDraft } from "../schema/edit-plan.ts";
import { validatePlan } from "../schema/validate.ts";
import { readJson, writeAtomic } from "../util/fs.ts";
import { sha256, stableStringify } from "../util/hash.ts";
import { buildPlanRequest, type PlanInput } from "./prompt.ts";

export type Usage = { input_tokens: number; output_tokens: number };

export type PlanMessage = {
  stop_reason: string | null;
  stop_details: { category: string | null; explanation: string | null } | null;
  content: { type: string; text?: string }[];
  usage: Usage;
};

export type PlanClient = {
  beta: {
    messages: {
      stream(params: BetaMessageStreamParams): { finalMessage(): Promise<PlanMessage> };
    };
  };
};

export type PlanResult = { plan: EditPlan; warnings: string[]; usage: Usage | null };

const INPUT_USD_PER_MTOK = 4;
const OUTPUT_USD_PER_MTOK = 20;

const Cached = z.object({
  plan: EditPlan,
  warnings: z.array(z.string()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 1e6;
}

// Output includes adaptive thinking, so the range is wide.
const OUTPUT_TOKENS_LOW = 8_000;
const OUTPUT_TOKENS_HIGH = 40_000;
const TOKEN_PX = 28;

export function estimateRequest(params: BetaMessageStreamParams, sizes: PlanInput["sheets"]["sizes"]) {
  const blocks = params.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
  const chars = blocks.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const imageTokens = sizes.reduce(
    (sum, s) => sum + Math.ceil(s.width / TOKEN_PX) * Math.ceil(s.height / TOKEN_PX),
    0,
  );
  const inputTokens = imageTokens + Math.ceil((chars + String(params.system).length) / 4);
  return {
    images: sizes.length,
    inputTokens,
    low: estimateCost(inputTokens, OUTPUT_TOKENS_LOW),
    high: estimateCost(inputTokens, OUTPUT_TOKENS_HIGH),
  };
}

export function formatUsage(usage: Usage): string {
  const cost = estimateCost(usage.input_tokens, usage.output_tokens).toFixed(2);
  return `${usage.input_tokens} input and ${usage.output_tokens} output tokens, about $${cost}`;
}

export function planCachePath(params: BetaMessageStreamParams, cacheDir: string): string {
  return join(cacheDir, `${sha256(stableStringify(params))}.json`);
}

export async function makePlan(
  client: PlanClient,
  input: PlanInput,
  opts: { cacheDir: string; env?: Record<string, string | undefined> },
): Promise<PlanResult> {
  const params = buildPlanRequest(input, opts.env);
  const cacheFile = planCachePath(params, opts.cacheDir);
  if (existsSync(cacheFile)) {
    const { plan, warnings } = await readJson(cacheFile, Cached);
    return { plan, warnings, usage: null };
  }

  const message = await client.beta.messages.stream(params).finalMessage();
  if (message.stop_reason === "refusal") {
    const details = message.stop_details;
    throw new Error(
      `the director refused (${details?.category ?? "no category"}): ` +
        `${details?.explanation ?? "no explanation"}`,
    );
  }
  if (message.stop_reason !== "end_turn") {
    throw new Error(`the director stopped early: ${message.stop_reason}`);
  }

  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const draft = EditPlanDraft.parse(JSON.parse(text));
  const { width, height, fps, duration } = input.probe;
  const plan = EditPlan.parse({ ...draft, meta: { ...draft.meta, source: { width, height, fps, duration } } });
  const { errors, warnings } = validatePlan(plan, input.probe);
  if (errors.length > 0) throw new Error(`the plan is invalid:\n${errors.join("\n")}`);

  await writeAtomic(cacheFile, `${JSON.stringify({ plan, warnings, usage: message.usage })}\n`);
  return { plan, warnings, usage: message.usage };
}
