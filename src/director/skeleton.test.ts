import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validatePlan } from "../schema/validate.ts";
import { skeletonFromNarration } from "./skeleton.ts";

const probe = { width: 1280, height: 720, fps: 30, duration: 40 };
const opts = { project: "demo", title: "Demo", voiceId: "voice1", modelId: "model1" };

test("timestamped blocks become scenes ending where the next begins", () => {
  const { plan } = skeletonFromNarration("# 0:00\nOne.\n\n# 0:12\nTwo.\n\n# 0:30\nThree.", probe, opts);
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
  const { plan } = skeletonFromNarration("a\n\nb\n\nc\n\nd", probe, opts);
  assert.deepEqual(
    plan.chapters[0].scenes.map((s) => s.source.in),
    [0, 10, 20, 30],
  );
  assert.equal(plan.chapters[0].scenes[3].source.out, 40);
});

function scenes(text: string, duration: number) {
  const short = { ...probe, duration };
  const { plan, warnings } = skeletonFromNarration(text, short, opts);
  assert.deepEqual(validatePlan(plan, short).errors, []);
  return { ranges: plan.chapters[0].scenes.map((s) => [s.source.in, s.source.out]), warnings };
}

test("timestamps past the end are dropped and their blocks spread in the gap", () => {
  const { ranges, warnings } = scenes("# 0:00\nOne.\n\n# 0:12\nTwo.\n\n# 0:30\nThree.", 12);
  assert.deepEqual(ranges, [[0, 4], [4, 8], [8, 12]]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /block 3: ignored timestamp 0:30/);
});

test("out-of-order timestamps are dropped", () => {
  const { ranges, warnings } = scenes("# 0:10\nOne.\n\n# 0:04\nTwo.\n\n# 0:30\nThree.", 40);
  assert.deepEqual(ranges, [[10, 20], [20, 30], [30, 40]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /block 2: ignored timestamp 0:04, out of order/);
  assert.doesNotMatch(warnings[0], /not inside the recording/);
});

test("only timestamps at or past the end are called outside the recording", () => {
  const { warnings } = scenes("# 0:02\nOne.\n\n# 0:09\nTwo.\n\n# 0:30\nThree.", 12);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /block 3: ignored timestamp 0:30, not inside the recording/);
});

test("a block over 600 characters splits at sentence boundaries into several lines", () => {
  const sentence = (n: number) => `Sentence ${n} ${"x".repeat(240)}.`;
  const text = [1, 2, 3].map(sentence).join(" ");
  const { plan } = skeletonFromNarration(`${text}\n\nShort.`, probe, opts);
  const lines = plan.chapters[0].scenes[0].narration;
  assert.deepEqual(lines.map((l) => l.id), ["s1-l1", "s1-l2"]);
  assert.deepEqual(lines.map((l) => l.text), [`${sentence(1)} ${sentence(2)}`, sentence(3)]);
  assert.ok(lines.every((l) => l.text.length <= 600));
  assert.equal(plan.chapters[0].scenes[1].narration.length, 1);
});

test("a single sentence over 600 characters is an error naming its block", () => {
  const long = `${"word ".repeat(130)}end.`;
  assert.throws(() => skeletonFromNarration(`Short.\n\n${long}`, probe, opts), /block 2.*600/);
});

test("a valid first timestamp keeps its start and later gaps fill evenly", () => {
  const { ranges } = scenes("# 0:02\na\n\nb\n\nc", 11);
  assert.deepEqual(ranges, [[2, 5], [5, 8], [8, 11]]);
});

test("more blocks than whole seconds is an error", () => {
  assert.throws(() => skeletonFromNarration("a\n\nb\n\nc", { ...probe, duration: 2.5 }, opts), /do not fit/);
});

test("a multi-line block becomes one narration line", () => {
  const { plan } = skeletonFromNarration("first\nsecond", probe, opts);
  assert.equal(plan.chapters[0].scenes[0].narration[0].text, "first second");
});

test("carries project, source dims, voice, and style defaults", () => {
  const { plan } = skeletonFromNarration("hello", probe, opts);
  assert.equal(plan.meta.project, "demo");
  assert.deepEqual(plan.meta.source, probe);
  assert.deepEqual(plan.audio.voice, { voiceId: "voice1", modelId: "model1" });
  assert.equal(plan.style.theme, "dark");
  assert.equal(plan.chapters.length, 1);
  assert.equal(plan.chapters[0].title, "Walkthrough");
  assert.equal(plan.chapters[0].scenes[0].fit, "freeze");
});

test("the repo's narration.txt against a 12 s probe yields a valid plan", () => {
  const text = readFileSync(new URL("../../narration.txt", import.meta.url), "utf8");
  const short = { ...probe, duration: 12 };
  const { plan } = skeletonFromNarration(text, short, opts);
  assert.deepEqual(validatePlan(plan, short).errors, []);
});

test("the repo's narration.txt yields a valid plan", () => {
  const text = readFileSync(new URL("../../narration.txt", import.meta.url), "utf8");
  const { plan } = skeletonFromNarration(text, probe, opts);
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
