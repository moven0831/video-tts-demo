import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson } from "../util/fs.ts";
import { Timeline } from "../timeline/types.ts";
import { Probe, VoiceManifest } from "./artifacts.ts";
import { EditPlan } from "./edit-plan.ts";

const fixture = (name: string) => new URL(`../../test/fixtures/${name}`, import.meta.url).pathname;

test("every fixture validates against its schema", async () => {
  await readJson(fixture("probe.json"), Probe);
  await readJson(fixture("edit-plan.json"), EditPlan);
  await readJson(fixture("voice.json"), VoiceManifest);
  await readJson(fixture("timeline.json"), Timeline);
});

test("voice.json covers every narration line in the plan", async () => {
  const plan = await readJson(fixture("edit-plan.json"), EditPlan);
  const voice = await readJson(fixture("voice.json"), VoiceManifest);
  const cards = [plan.intro, plan.outro, ...plan.chapters.map((c) => c.card)];
  const lines = [
    ...cards.flatMap((card) => card?.narration ?? []),
    ...plan.chapters.flatMap((c) => c.scenes.flatMap((s) => s.narration)),
  ];
  assert.deepEqual(Object.keys(voice.lines).sort(), lines.map((l) => l.id).sort());
  for (const [id, line] of Object.entries(voice.lines)) assert.equal(line.file, `${id}.mp3`);
});

test("timeline.json narrates every voice line inside the total", async () => {
  const voice = await readJson(fixture("voice.json"), VoiceManifest);
  const timeline = await readJson(fixture("timeline.json"), Timeline);
  assert.deepEqual(
    timeline.narration.map((n) => n.lineId).sort(),
    Object.keys(voice.lines).sort(),
  );
  for (const n of timeline.narration) {
    assert.equal(n.duration, voice.lines[n.lineId].duration);
    assert.ok(n.start + n.duration <= timeline.total);
  }
});
