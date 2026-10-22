import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Probe } from "../schema/artifacts.ts";
import { EditPlan, EditPlanDraft } from "../schema/edit-plan.ts";
import { validatePlan } from "../schema/validate.ts";
import { readJson, writeAtomic, writeJson } from "../util/fs.ts";
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

type Checked = { plan: EditPlan; warnings: string[] } | { errors: string[] };

function checkReply(text: string, probe: Probe): Checked {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { errors: [`the reply is not valid JSON: ${err instanceof Error ? err.message : err}`] };
  }
  const draft = EditPlanDraft.safeParse(json);
  if (!draft.success) return { errors: [z.prettifyError(draft.error)] };
  const { width, height, fps, duration } = probe;
  const full = EditPlan.safeParse({
    ...draft.data,
    meta: { ...draft.data.meta, source: { width, height, fps, duration } },
  });
  if (!full.success) return { errors: [z.prettifyError(full.error)] };
  const { errors, warnings } = validatePlan(full.data, probe);
  return errors.length > 0 ? { errors } : { plan: full.data, warnings };
}

// The reply was paid for, so a rejected one is kept for hand repair instead of being dropped.
export async function makePlan(
  client: PlanClient,
  input: PlanInput,
  opts: { cacheDir: string; rejectedPath: string; env?: Record<string, string | undefined> },
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

  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const reject = async (errors: string[], hint: string, headline?: string): Promise<never> => {
    await writeJson(opts.rejectedPath, { text, errors });
    const lines = headline ? [headline, ...errors] : errors;
    throw new Error(`${lines.join("\n")}\nthe reply is saved in ${opts.rejectedPath}; ${hint}`);
  };
  if (message.stop_reason !== "end_turn") {
    const hint = message.stop_reason === "max_tokens" ? "try a lower DEMO_EFFORT, then rerun" : "rerun";
    return reject([`the director stopped early: ${message.stop_reason}`], hint);
  }

  const checked = checkReply(text, input.probe);
  if ("errors" in checked) {
    return reject(checked.errors, "fix it and save it as edit-plan.json, or rerun", "the plan is invalid:");
  }
  const { plan, warnings } = checked;

  await writeAtomic(cacheFile, `${JSON.stringify({ plan, warnings, usage: message.usage })}\n`);
  return { plan, warnings, usage: message.usage };
}
