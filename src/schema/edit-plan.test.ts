import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EditPlan, EditPlanDraft, sfxCues } from "./edit-plan.ts";

const plan = JSON.parse(
  readFileSync(new URL("../../test/fixtures/edit-plan.json", import.meta.url), "utf8"),
);

// Keywords structured outputs accept. The SDK folds the rest into `description`.
const ALLOWED = new Set([
  "$defs",
  "$ref",
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "minItems",
]);

type Node = Record<string, unknown>;

function schemaNodes(node: unknown, path = "$"): { path: string; node: Node }[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => schemaNodes(n, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const children = Object.entries(node).flatMap(([key, value]) =>
    schemaNodes(value, `${path}.${key}`),
  );
  return [{ path, node: node as Node }, ...children];
}

test("defaults are applied when parsing a minimal plan", () => {
  const minimal = structuredClone(plan);
  delete minimal.style.camera.moveSec;
  delete minimal.chapters[0].transition;
  delete minimal.chapters[0].scenes[1].fit;
  const parsed = EditPlan.parse(minimal);
  assert.equal(parsed.style.camera.moveSec, 0.7);
  assert.deepEqual(parsed.chapters[0].transition, { kind: "cut", sec: 0 });
  assert.equal(parsed.chapters[0].scenes[1].fit, "freeze");
});

test("the draft schema drops meta.source", () => {
  const draft = structuredClone(plan);
  delete draft.meta.source;
  assert.ok(EditPlanDraft.safeParse(draft).success);
  assert.ok(!EditPlan.safeParse(draft).success);
});

test("a bad slug is rejected", () => {
  const bad = structuredClone(plan);
  bad.chapters[0].id = "Not A Slug";
  assert.ok(!EditPlan.safeParse(bad).success);
});

test("zodOutputFormat builds and sends a schema structured outputs accept", () => {
  const { schema } = zodOutputFormat(EditPlanDraft);
  const nodes = schemaNodes(schema);
  const objects = nodes.filter(({ node }) => node.type === "object");
  assert.ok(objects.length > 10);
  for (const { path, node } of objects) {
    assert.equal(node.additionalProperties, false, `${path} must set additionalProperties:false`);
    assert.deepEqual(
      Object.keys(node).filter((key) => !ALLOWED.has(key)),
      [],
      `${path} has unsupported keywords`,
    );
  }
  for (const { path, node } of nodes) {
    if (node.type === "object" || !("type" in node || "$ref" in node || "anyOf" in node)) continue;
    assert.deepEqual(
      Object.keys(node).filter((key) => !ALLOWED.has(key)),
      [],
      `${path} has unsupported keywords`,
    );
    if ("minItems" in node) assert.ok((node.minItems as number) <= 1, `${path} minItems`);
  }
});

test("sfx cues are numbered per scene in plan order", () => {
  const cue = (scene: string) => ({ scene, t: 1, prompt: "p", sec: 1 });
  const parsed = EditPlan.parse({
    ...plan,
    audio: { ...plan.audio, sfx: [cue("a"), cue("b"), cue("a")] },
  });
  assert.deepEqual(
    sfxCues(parsed).map((c) => [c.id, c.scene]),
    [
      ["a-0", "a"],
      ["b-0", "b"],
      ["a-1", "a"],
    ],
  );
});

test("music.file is a bare filename inside music/", () => {
  const withFile = (file: string) => ({ ...plan, audio: { ...plan.audio, music: { file } } });
  EditPlan.parse(withFile("bed.mp3"));
  for (const bad of ["../bed.mp3", "/etc/passwd", "a/b.mp3", "a\\b.mp3", ".hidden.mp3", "..", ""]) {
    assert.throws(() => EditPlan.parse(withFile(bad)), bad);
  }
});
