import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Probe } from "../schema/artifacts.ts";
import { makePlan, type PlanClient, type PlanMessage } from "./plan.ts";
import type { PlanInput } from "./prompt.ts";

const fixture = JSON.parse(readFileSync("test/fixtures/edit-plan.json", "utf8"));
const probe: Probe = JSON.parse(readFileSync("test/fixtures/probe.json", "utf8"));
const { source: _source, ...meta } = fixture.meta;
const draftText = (plan: unknown = { ...fixture, meta }) => JSON.stringify(plan);

const input: PlanInput = {
  probe,
  scenes: [],
  motion: { boxes: [], idle: [] },
  sheets: { content: [], sizes: [] },
};

function message(over: Partial<PlanMessage> = {}): PlanMessage {
  return {
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: draftText() }],
    usage: { input_tokens: 1000, output_tokens: 2000 },
    ...over,
  };
}

function fakeClient(reply: PlanMessage) {
  const calls: unknown[] = [];
  const client: PlanClient = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return { finalMessage: async () => reply };
        },
      },
    },
  };
  return { client, calls };
}

async function withCache(run: (cacheDir: string, rejectedPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));
  try {
    await run(join(dir, "cache"), join(dir, "build", "plan.rejected.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a valid reply becomes a plan with meta.source filled from the probe", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const { client, calls } = fakeClient(message());
    const result = await makePlan(client, input, { cacheDir, rejectedPath });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.plan, fixture);
    assert.deepEqual(result.usage, { input_tokens: 1000, output_tokens: 2000 });
  });
});

test("a refusal throws with its category and explanation", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const reply = message({
      stop_reason: "refusal",
      stop_details: { category: "general_harms", explanation: "declined" },
    });
    await assert.rejects(
      makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath }),
      /refused \(general_harms\): declined/,
    );
  });
});

test("any other stop reason throws, and max_tokens suggests a lower effort", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const reply = message({ stop_reason: "max_tokens" });
    await assert.rejects(
      makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath }),
      /max_tokens.*DEMO_EFFORT/s,
    );
    assert.equal(JSON.parse(await readFile(rejectedPath, "utf8")).text, draftText());
  });
});

test("a thinking block before the text block still parses", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const reply = message({
      content: [
        { type: "thinking" },
        { type: "text", text: draftText() },
      ],
    });
    const result = await makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath });
    assert.deepEqual(result.plan, fixture);
  });
});

test("an unparsable reply is saved, not cached, and the error names the file", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const reply = message({ content: [{ type: "text", text: "{" }] });
    await assert.rejects(
      makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath }),
      (err: Error) => {
        assert.match(err.message, /not valid JSON/);
        assert.ok(err.message.includes(rejectedPath), err.message);
        assert.match(err.message, /save it as edit-plan\.json/);
        return true;
      },
    );
    const saved = JSON.parse(await readFile(rejectedPath, "utf8"));
    assert.equal(saved.text, "{");
    assert.match(saved.errors[0], /not valid JSON/);
    await assert.rejects(readdir(cacheDir));
  });
});

test("a schema failure is saved with its field path", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const bad = structuredClone({ ...fixture, meta });
    bad.chapters[0].id = "Not A Slug";
    const reply = message({ content: [{ type: "text", text: draftText(bad) }] });
    await assert.rejects(
      makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath }),
      (err: Error) => {
        assert.ok(err.message.includes(rejectedPath), err.message);
        assert.match(err.message, /chapters\[0\]\.id/);
        return true;
      },
    );
    assert.equal(JSON.parse(await readFile(rejectedPath, "utf8")).text, draftText(bad));
    await assert.rejects(readdir(cacheDir));
  });
});

test("validation errors are listed and nothing is cached", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    const bad = structuredClone({ ...fixture, meta });
    bad.chapters[0].scenes[0].source.out = 99;
    const reply = message({ content: [{ type: "text", text: draftText(bad) }] });
    await assert.rejects(
      makePlan(fakeClient(reply).client, input, { cacheDir, rejectedPath }),
      /past the source duration 8/,
    );
    assert.match(JSON.parse(await readFile(rejectedPath, "utf8")).errors.join("\n"), /past the source duration 8/);
    await assert.rejects(readdir(cacheDir));
  });
});

test("a cache hit makes no API call", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    await makePlan(fakeClient(message()).client, input, { cacheDir, rejectedPath });
    const second = fakeClient(message({ stop_reason: "refusal" }));
    const result = await makePlan(second.client, input, { cacheDir, rejectedPath });
    assert.equal(second.calls.length, 0);
    assert.deepEqual(result.plan, fixture);
    assert.equal(result.usage, null);
  });
});

test("a different request misses the cache", async () => {
  await withCache(async (cacheDir, rejectedPath) => {
    await makePlan(fakeClient(message()).client, input, { cacheDir, rejectedPath });
    const second = fakeClient(message());
    await makePlan(second.client, { ...input, brief: "Be brief." }, { cacheDir, rejectedPath });
    assert.equal(second.calls.length, 1);
  });
});
