import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VoiceManifest } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_VOICE_ID,
  lineKey,
  musicKey,
  narrationLines,
  planMusicKey,
  resolveVoice,
  sfxItems,
  sfxKey,
  staleVoice,
} from "./keys.ts";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const fixture = EditPlan.parse(read("edit-plan.json"));
const manifest = VoiceManifest.parse(read("voice.json"));

test("line and clip keys stay byte-identical so the paid cache stays valid", () => {
  const line = { id: "a", text: "Hello there.", previousText: "Before.", nextText: "After." };
  assert.equal(
    lineKey(line, "voiceX", "modelY"),
    "298e8505177fe46f510f7cb060618779f802e419443a26b40d68cdbaa41a5fb7",
  );
  assert.equal(
    lineKey({ id: "a", text: "Hello there." }, "voiceX", "modelY"),
    "c40a050a1361169deb1317ef18d4b04576a089e275926016281ee14651a58b8d",
  );
  assert.equal(
    lineKey({ id: "a", text: "Hello there." }, "voiceX", "modelY", true),
    "342392403ac6200bc08b7953bd8c60e69655636211797ab44154dc2eea05c8eb",
  );
  const clip = "a77fb85cc4728256ae4040dde2724cfdb901907a6b87aed0d638c7a432c46c64";
  assert.equal(sfxKey("soft click", 1.5), clip);
  assert.equal(musicKey("soft click", 1.5), clip);
});

test("default voice and model fall back to the built-in ids", () => {
  assert.deepEqual(resolveVoice({ voiceId: "default", modelId: "default" }, {}), {
    voiceId: DEFAULT_VOICE_ID,
    modelId: DEFAULT_MODEL_ID,
  });
});

test("keys.ts stays free of the ElevenLabs SDK", () => {
  assert.doesNotMatch(readFileSync(new URL("./keys.ts", import.meta.url), "utf8"), /^import .*elevenlabs/im);
});

test("a manifest made for the plan is not stale", () => {
  assert.deepEqual(staleVoice(fixture, manifest, {}), []);
});

test("editing a line's text marks that line and its neighbours", () => {
  const plan = structuredClone(fixture);
  plan.chapters[0].scenes[0].narration[0].text = "Open the app now.";
  assert.deepEqual(staleVoice(plan, manifest, {}), [
    'line "intro-1" changed since voice ran',
    'line "open-1" changed since voice ran',
    'line "open-2" changed since voice ran',
  ]);
});

test("a different voice id marks every line", () => {
  const plan = structuredClone(fixture);
  plan.audio.voice.voiceId = "other";
  const lines = narrationLines(plan).map((l) => `line "${l.id}" changed since voice ran`);
  assert.deepEqual(staleVoice(plan, manifest, {}), lines);
});

test("a default voice resolves from env before it is compared", () => {
  const plan = structuredClone(fixture);
  plan.audio.voice = { voiceId: "default", modelId: "default" };
  assert.deepEqual(staleVoice(plan, manifest, {}), []);
  const stale = staleVoice(plan, manifest, { ELEVENLABS_VOICE_ID: "envVoice" });
  assert.equal(stale.length, narrationLines(plan).length);
});

test("changing an sfx prompt marks that cue", () => {
  const plan = structuredClone(fixture);
  plan.audio.sfx[0].prompt = "a different click";
  assert.deepEqual(staleVoice(plan, manifest, {}), ['sfx "open-app-0" changed since voice ran']);
});

test("an sfx cue the manifest lacks is reported", () => {
  const plan = structuredClone(fixture);
  plan.audio.sfx.push({ scene: "click-through", t: 6, prompt: "ding", sec: 1 });
  assert.deepEqual(staleVoice(plan, manifest, {}), ['sfx "click-through-0" is missing from voice.json']);
  assert.equal(sfxItems(plan).length, 2);
});

test("music added, changed and removed are all reported", () => {
  const added = structuredClone(fixture);
  added.audio.music.prompt = "calm piano";
  assert.deepEqual(staleVoice(added, manifest, {}), ["music was added since voice ran"]);

  const key = planMusicKey(added);
  assert.ok(key);
  const withMusic = { ...manifest, music: { file: "cache/music/m.mp3", key, duration: 30 } };
  assert.deepEqual(staleVoice(added, withMusic, {}), []);

  const changed = structuredClone(added);
  changed.audio.music.prompt = "loud drums";
  assert.deepEqual(staleVoice(changed, withMusic, {}), ["music changed since voice ran"]);

  assert.deepEqual(staleVoice(fixture, withMusic, {}), ["music was removed since voice ran"]);
});

test("a music file is keyed by name, and wins over a prompt", () => {
  const plan = structuredClone(fixture);
  plan.audio.music.file = "bed.mp3";
  plan.audio.music.prompt = "calm piano";
  const bare = structuredClone(fixture);
  bare.audio.music.file = "bed.mp3";
  assert.equal(planMusicKey(plan), planMusicKey(bare));
  assert.notEqual(planMusicKey(plan), planMusicKey(fixture));
});
