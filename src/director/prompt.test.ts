import assert from "node:assert/strict";
import { test } from "node:test";
import { stableStringify } from "../util/hash.ts";
import type { PlanInput } from "./prompt.ts";
import { buildPlanRequest } from "./prompt.ts";

const input = (): PlanInput => ({
  probe: { width: 1280, height: 720, fps: 30, duration: 8 },
  scenes: [{ t: 4, score: 0.4 }],
  motion: {
    boxes: [
      { t: 0, box: null },
      { t: 1, box: { x: 10, y: 20, w: 300, h: 200 } },
    ],
    idle: [{ t0: 5, t1: 8 }],
  },
  brief: "Audience: new admins.",
  sheets: {
    content: [
      { type: "text", text: "Sheet 1: 0:00–0:08" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ],
    sizes: [{ width: 1920, height: 1080 }],
  },
});

test("the same input builds byte-identical params", () => {
  assert.equal(stableStringify(buildPlanRequest(input(), {})), stableStringify(buildPlanRequest(input(), {})));
});

test("defaults: Opus 5.5, high effort, structured output, server-side fallback", () => {
  const params = buildPlanRequest(input(), {});
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 64000);
  assert.equal(params.output_config?.effort, "high");
  assert.equal(params.output_config?.format?.type, "json_schema");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
  assert.equal("thinking" in params, false);
});

test("DEMO_MODEL and DEMO_EFFORT override the defaults", () => {
  const params = buildPlanRequest(input(), { DEMO_MODEL: "m", DEMO_EFFORT: "max" });
  assert.equal(params.model, "m");
  assert.equal(params.output_config?.effort, "max");
  assert.throws(() => buildPlanRequest(input(), { DEMO_EFFORT: "extreme" }));
});

test("the system prompt is the director brief and the user turn carries every input", () => {
  const params = buildPlanRequest(input(), {});
  assert.match(String(params.system), /^# Director brief/);
  const content = params.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((block) => block.type),
    ["text", "text", "image", "text"],
  );
  const context = (content[0] as { text: string }).text;
  assert.match(context, /"width":1280/);
  assert.match(context, /"score":0\.4/);
  assert.match(context, /^1: 10,20,300,200$/m);
  assert.doesNotMatch(context, /^0: /m);
  assert.match(context, /Idle spans: 5-8/);
  assert.match(context, /Audience: new admins\./);
});

test("a missing brief is stated, not omitted", () => {
  const { brief: _brief, ...rest } = input();
  const content = buildPlanRequest(rest, {}).messages[0].content;
  assert.ok(Array.isArray(content));
  assert.match((content[0] as { text: string }).text, /Brief: none/);
});
