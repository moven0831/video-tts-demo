import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validatePlan } from "../schema/validate.ts";
import { skeletonFromNarration } from "./skeleton.ts";

const probe = { width: 1280, height: 720, fps: 30, duration: 40 };
const opts = { project: "demo", title: "Demo", voiceId: "voice1", modelId: "model1" };

test("timestamped blocks become scenes ending where the next begins", () => {
  const plan = skeletonFromNarration("# 0:00\nOne.\n\n# 0:12\nTwo.\n\n# 0:30\nThree.", probe, opts);
  assert.deepEqual(
    plan.chapters[0].scenes.map((s) => [s.id, s.source.in, s.source.out]),
    [
      ["s1", 0, 12],
      ["s2", 12, 30],
      ["s3", 30, 40],
    ],
  );
  assert.deepEqual(
    plan.chapters[0].scenes.map((s) => s.narration.map((l) => [l.id, l.text])),
    [[["s1-l1", "One."]], [["s2-l1", "Two."]], [["s3-l1", "Three."]]],
  );
  assert.deepEqual(validatePlan(plan, probe), { errors: [], warnings: [] });
});

test("blocks without timestamps are spread evenly", () => {
  const plan = skeletonFromNarration("a\n\nb\n\nc\n\nd", probe, opts);
  assert.deepEqual(
    plan.chapters[0].scenes.map((s) => s.source.in),
    [0, 10, 20, 30],
  );
  assert.equal(plan.chapters[0].scenes[3].source.out, 40);
});

test("a multi-line block becomes one narration line", () => {
  const plan = skeletonFromNarration("first\nsecond", probe, opts);
  assert.equal(plan.chapters[0].scenes[0].narration[0].text, "first second");
});

test("carries project, source dims, voice, and style defaults", () => {
  const plan = skeletonFromNarration("hello", probe, opts);
  assert.equal(plan.meta.project, "demo");
  assert.deepEqual(plan.meta.source, probe);
  assert.deepEqual(plan.audio.voice, { voiceId: "voice1", modelId: "model1" });
  assert.equal(plan.style.theme, "dark");
  assert.equal(plan.chapters.length, 1);
  assert.equal(plan.chapters[0].scenes[0].fit, "freeze");
});

test("the repo's narration.txt yields a valid plan", () => {
  const text = readFileSync(new URL("../../narration.txt", import.meta.url), "utf8");
  const plan = skeletonFromNarration(text, probe, opts);
  assert.deepEqual(
    plan.chapters[0].scenes.map((s) => [s.source.in, s.source.out]),
    [
      [0, 12],
      [12, 30],
      [30, 40],
    ],
  );
  assert.deepEqual(validatePlan(plan, probe).errors, []);
});
