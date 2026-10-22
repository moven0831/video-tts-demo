import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VoiceManifest, type Word } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { projectPaths } from "../util/project.ts";
import type { CharAlignment } from "./align.ts";
import type { TtsOptions, Voice } from "./elevenlabs.ts";
import { runAudition, runVoice } from "./generate.ts";
import { estimateVideoSeconds, lineKey, narrationLines, sfxItems, sfxKey } from "./keys.ts";
import { cachePath, isCached } from "./cache.ts";

const fixture = EditPlan.parse(
  JSON.parse(readFileSync(new URL("../../test/fixtures/edit-plan.json", import.meta.url), "utf8")),
);

type Call = { method: string; args: unknown[] };

function fakeVoice(
  opts: { alignment?: boolean; normalized?: boolean; alignFails?: boolean; sfxAudio?: Buffer } = {},
) {
  const calls: Call[] = [];
  const voice: Voice = {
    async tts(text: string, o: TtsOptions) {
      calls.push({ method: "tts", args: [text, o] });
      const audio = Buffer.from(`audio:${text}`);
      if (opts.alignment === false) return { audio };
      const characters = [...text];
      const alignment: CharAlignment = {
        characters,
        characterStartTimesSeconds: characters.map((_, i) => i / 10),
        characterEndTimesSeconds: characters.map((_, i) => (i + 1) / 10),
      };
      return opts.normalized ? { audio, alignment, normalized: true as const } : { audio, alignment };
    },
    async align(audio: Buffer, text: string) {
      calls.push({ method: "align", args: [audio.toString(), text] });
      if (opts.alignFails) throw new Error("align down");
      const words: Word[] = text.split(" ").map((w, i) => ({ text: w, start: i, end: i + 0.5 }));
      return words;
    },
    async sfx(prompt: string, seconds: number) {
      calls.push({ method: "sfx", args: [prompt, seconds] });
      return opts.sfxAudio ?? Buffer.from(`sfx:${prompt}`);
    },
    async music(prompt: string, seconds: number) {
      calls.push({ method: "music", args: [prompt, seconds] });
      return Buffer.from(`music:${prompt}`);
    },
  };
  return { voice, calls };
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "voice-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  return {
    paths: projectPaths(join(dir, "demo")),
    lines,
    log: (line: string) => lines.push(line),
    duration: async () => 1.5,
  };
}

const withMusic = (prompt: string) => {
  const plan = structuredClone(fixture);
  plan.audio.music.prompt = prompt;
  return plan;
};

test("narration lines follow output order and stitch to their neighbours", () => {
  const lines = narrationLines(fixture);
  assert.deepEqual(
    lines.map((l) => l.id),
    ["intro-1", "open-1", "open-2", "click-1", "outro-1"],
  );
  assert.deepEqual(lines[0], {
    id: "intro-1",
    text: "Welcome to the product tour.",
    previousText: undefined,
    nextText: "Start by opening the app.",
  });
  assert.equal(lines[2].previousText, lines[1].text);
  assert.equal(lines[2].nextText, lines[3].text);
  assert.equal(lines[4].nextText, undefined);
});

test("chapter card lines come before the chapter's scene lines", () => {
  const plan = structuredClone(fixture);
  const card = plan.chapters[0].card;
  assert.ok(card);
  card.narration = [{ id: "card-1", text: "Chapter one.", pauseAfter: 0.35 }];
  assert.deepEqual(
    narrationLines(plan).map((l) => l.id),
    ["intro-1", "card-1", "open-1", "open-2", "click-1", "outro-1"],
  );
});

test("sfx ids are scene id and the index within that scene", () => {
  const plan = structuredClone(fixture);
  plan.audio.sfx.push(
    { scene: "open-app", t: 3, prompt: "whoosh", sec: 1 },
    { scene: "click-through", t: 6, prompt: "ding", sec: 1 },
  );
  assert.deepEqual(
    sfxItems(plan).map((s) => s.id),
    ["open-app-0", "open-app-1", "click-through-0"],
  );
});

test("estimated length counts cards, the longer of source and speech per scene, and caps at 300 s", () => {
  const cards = 9;
  const scenes = fixture.chapters.flatMap((c) => c.scenes);
  const expected = scenes.reduce((sum, scene) => {
    const chars = scene.narration.reduce((n, l) => n + l.text.length, 0);
    return sum + Math.max(scene.source.out - scene.source.in, chars / 15 + 1);
  }, cards);
  assert.equal(estimateVideoSeconds(fixture), Math.ceil(expected));

  const wordy = structuredClone(fixture);
  wordy.chapters[0].scenes[0].narration[0].text = "x".repeat(450);
  assert.ok(estimateVideoSeconds(wordy) > estimateVideoSeconds(fixture) + 20);

  const huge = structuredClone(fixture);
  huge.chapters[0].scenes[0].source = { in: 0, out: 900 };
  assert.equal(estimateVideoSeconds(huge), 300);
});

test("estimated length never falls below the 3 s the music API accepts", () => {
  const tiny = structuredClone(fixture);
  delete tiny.intro;
  delete tiny.outro;
  tiny.chapters = [{ ...tiny.chapters[0], card: undefined, scenes: [tiny.chapters[0].scenes[0]] }];
  tiny.chapters[0].scenes[0].source = { in: 0, out: 1 };
  tiny.chapters[0].scenes[0].narration = [{ ...tiny.chapters[0].scenes[0].narration[0], text: "a" }];
  assert.equal(estimateVideoSeconds(tiny), 3);
});

test("dry run and a missing --yes make no calls and write nothing", async (t) => {
  const { paths, lines, log, duration } = await setup(t);
  const { voice, calls } = fakeVoice();
  assert.equal(await runVoice(fixture, { voice, duration }, paths, { yes: true, dryRun: true, log, env: {} }), undefined);
  assert.equal(await runVoice(fixture, { voice, duration }, paths, { yes: false, dryRun: false, log, env: {} }), undefined);
  assert.deepEqual(calls, []);
  assert.ok(lines.some((l) => l.startsWith("intro-1  28 chars  new")));
  assert.ok(lines.some((l) => l.startsWith("lines: 5, characters:")));
  assert.ok(lines.includes("sfx open-app-0  0.5 s  new"));
  await assert.rejects(stat(paths.voice), /ENOENT/);
});

test("without --yes, an all-cached plan still writes voice.json and spends nothing", async (t) => {
  const { paths, log, duration } = await setup(t);
  const first = fakeVoice();
  await runVoice(fixture, { voice: first.voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  await rm(paths.voice);

  const again = fakeVoice();
  const manifest = await runVoice(fixture, { voice: again.voice, duration }, paths, {
    yes: false,
    dryRun: false,
    log,
    env: {},
  });
  assert.deepEqual(again.calls, []);
  assert.deepEqual(VoiceManifest.parse(JSON.parse(await readFile(paths.voice, "utf8"))), manifest);
});

test("a dry run never writes voice.json, even when everything is cached", async (t) => {
  const { paths, log, duration } = await setup(t);
  const { voice } = fakeVoice();
  await runVoice(fixture, { voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  await rm(paths.voice);
  assert.equal(await runVoice(fixture, { voice, duration }, paths, { yes: false, dryRun: true, log, env: {} }), undefined);
  await assert.rejects(stat(paths.voice), /ENOENT/);
});

test("--yes generates in output order with stitched neighbours and writes a valid manifest", async (t) => {
  const { paths, log, duration } = await setup(t);
  const { voice, calls } = fakeVoice();
  const manifest = await runVoice(fixture, { voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  const tts = calls.filter((c) => c.method === "tts").map((c) => c.args as [string, TtsOptions]);
  assert.deepEqual(
    tts.map(([text]) => text),
    narrationLines(fixture).map((l) => l.text),
  );
  assert.equal(tts[1][1].previousText, tts[0][0]);
  assert.equal(tts[1][1].nextText, tts[2][0]);
  assert.deepEqual(
    [tts[0][1].voiceId, tts[0][1].modelId],
    [fixture.audio.voice.voiceId, fixture.audio.voice.modelId],
  );
  const written = VoiceManifest.parse(JSON.parse(await readFile(paths.voice, "utf8")));
  assert.deepEqual(written, manifest);
  assert.deepEqual(Object.keys(written.lines), ["intro-1", "open-1", "open-2", "click-1", "outro-1"]);
  assert.deepEqual(Object.keys(written.sfx), ["open-app-0"]);
  assert.equal(written.music, undefined);
  assert.match(written.lines["intro-1"].file, /^cache\/voice\/[0-9a-f]{64}\.mp3$/);
  assert.equal(written.lines["intro-1"].duration, 1.5);
  assert.equal(written.lines["intro-1"].words[0].text, "Welcome");
  await stat(join(paths.build, written.sfx["open-app-0"].file));
});

test("a second run is all cache hits", async (t) => {
  const { paths, lines, log, duration } = await setup(t);
  const first = fakeVoice();
  await runVoice(fixture, { voice: first.voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  const second = fakeVoice();
  await runVoice(fixture, { voice: second.voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  assert.deepEqual(second.calls, []);
  assert.ok(first.calls.length > 0);
  await runVoice(fixture, { voice: second.voice, duration }, paths, { yes: false, dryRun: true, log, env: {} });
  assert.ok(lines.includes("intro-1  28 chars  cached"));
  const chars = narrationLines(fixture).reduce((n, l) => n + l.text.length, 0);
  assert.ok(lines.includes(`lines: 5, characters: ${chars}, uncached characters: 0`));
});

test("changing a neighbour's text regenerates only the lines it touches", async (t) => {
  const { paths, log, duration } = await setup(t);
  await runVoice(fixture, { voice: fakeVoice().voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  const edited = structuredClone(fixture);
  edited.chapters[0].scenes[1].narration[0].text = "Click settings to continue.";
  const { voice, calls } = fakeVoice();
  await runVoice(edited, { voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  assert.deepEqual(
    calls.filter((c) => c.method === "tts").map((c) => (c.args as [string])[0]),
    ["Everything you need is on the left.", "Click settings to continue.", "That is all it takes."],
  );
});

test("missing alignment falls back to forced alignment, cached for next time", async (t) => {
  const { paths, lines, log, duration } = await setup(t);
  const { voice, calls } = fakeVoice({ alignment: false });
  const manifest = await runVoice(fixture, { voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  const aligns = calls.filter((c) => c.method === "align");
  assert.equal(aligns.length, 5);
  assert.deepEqual(aligns[0].args, ["audio:Welcome to the product tour.", "Welcome to the product tour."]);
  assert.deepEqual(manifest?.lines["intro-1"].words[0], { text: "Welcome", start: 0, end: 0.5 });
  assert.ok(lines.some((l) => l.startsWith("intro-1: no alignment from tts")));
  const again = fakeVoice({ alignment: false });
  await runVoice(fixture, { voice: again.voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  assert.deepEqual(again.calls, []);
});

test("music is composed only when a prompt is set and no file is given", async (t) => {
  const { paths, log, duration } = await setup(t);
  const { voice, calls } = fakeVoice();
  const manifest = await runVoice(withMusic("calm piano"), { voice, duration }, paths, {
    yes: true,
    dryRun: false,
    log,
    env: {},
  });
  const music = calls.filter((c) => c.method === "music");
  assert.equal(music.length, 1);
  assert.equal(music[0].args[0], "calm piano");
  assert.equal(music[0].args[1], estimateVideoSeconds(fixture));
  assert.match(manifest?.music?.file ?? "", /^cache\/music\/[0-9a-f]{64}\.mp3$/);

  const withFile = withMusic("calm piano");
  withFile.audio.music.file = "bed.mp3";
  const other = fakeVoice();
  const recorded = await runVoice(withFile, { voice: other.voice, duration }, paths, {
    yes: true,
    dryRun: false,
    log,
    env: {},
  });
  assert.equal(other.calls.filter((c) => c.method === "music").length, 0);
  assert.equal(recorded?.music?.file, "../music/bed.mp3");
});

test("audition renders each voice into build/audition and needs --yes", async (t) => {
  const { paths, log } = await setup(t);
  const { voice, calls } = fakeVoice();
  const opts = { text: "Hello there", voiceIds: ["v1", "v2"], modelId: "m", log };
  await runAudition({ voice }, paths, { ...opts, yes: false });
  assert.deepEqual(calls, []);
  await runAudition({ voice }, paths, { ...opts, yes: true });
  assert.equal(await readFile(join(paths.build, "audition", "v1.mp3"), "utf8"), "audio:Hello there");
  assert.equal(calls.length, 2);
  await runAudition({ voice }, paths, { ...opts, yes: true });
  assert.equal(calls.length, 2);
});

test("a real run after an audition of the same text does not trip over the audition's cache entry", async (t) => {
  const { paths, log, duration } = await setup(t);
  const plan = structuredClone(fixture);
  plan.intro = undefined;
  plan.outro = undefined;
  plan.audio.sfx = [];
  plan.chapters = [
    {
      ...plan.chapters[0],
      card: undefined,
      scenes: [{ ...plan.chapters[0].scenes[0], narration: [plan.chapters[0].scenes[0].narration[0]] }],
    },
  ];
  const [only] = narrationLines(plan);
  const { voiceId, modelId } = plan.audio.voice;
  const { voice, calls } = fakeVoice();
  await runAudition({ voice }, paths, { text: only.text, voiceIds: [voiceId], modelId, yes: true, log });

  const manifest = await runVoice(plan, { voice, duration }, paths, { yes: true, dryRun: false, log, env: {} });
  assert.equal(manifest?.lines[only.id].words[0].text, only.text.split(" ")[0]);
  assert.equal(calls.filter((c) => c.method === "tts").length, 2);
});

test("\"default\" voice and model resolve from env, then the built-in fallbacks", async (t) => {
  const plan = structuredClone(fixture);
  plan.audio.voice = { voiceId: "default", modelId: "default" };
  const { paths, log, duration } = await setup(t);
  const run = (voice: Voice, env: Record<string, string>) =>
    runVoice(plan, { voice, duration }, paths, { yes: true, dryRun: false, log, env });

  const fromEnv = fakeVoice();
  await run(fromEnv.voice, { ELEVENLABS_VOICE_ID: "envVoice", ELEVENLABS_MODEL_ID: "envModel" });
  const first = fromEnv.calls[0].args[1] as TtsOptions;
  assert.deepEqual([first.voiceId, first.modelId], ["envVoice", "envModel"]);

  const fallback = fakeVoice();
  await run(fallback.voice, {});
  const second = fallback.calls[0].args[1] as TtsOptions;
  assert.deepEqual([second.voiceId, second.modelId], ["JBFqnCBsd6RMkjVDRZzb", "eleven_v4"]);
});

const yesRun = { yes: true, dryRun: false, env: {} };

test("a failed forced alignment keeps the paid tts audio; the retry only aligns", async (t) => {
  const { paths, log, duration } = await setup(t);
  const first = fakeVoice({ alignment: false, alignFails: true });
  await assert.rejects(runVoice(fixture, { voice: first.voice, duration }, paths, { ...yesRun, log }), /align down/);
  assert.deepEqual(first.calls.map((c) => c.method), ["tts", "align"]);

  const [intro] = narrationLines(fixture);
  const key = lineKey(intro, fixture.audio.voice.voiceId, fixture.audio.voice.modelId);
  const dir = paths.cacheDir("voice");
  assert.equal(await isCached(dir, key, "mp3"), false);
  assert.equal(await isCached(dir, key, "tts.mp3"), true);

  const retry = fakeVoice({ alignment: false });
  const manifest = await runVoice(fixture, { voice: retry.voice, duration }, paths, { ...yesRun, log });
  const ttsTexts = retry.calls.filter((c) => c.method === "tts").map((c) => (c.args as [string])[0]);
  assert.ok(!ttsTexts.includes(intro.text), "the intro line is not synthesised again");
  assert.deepEqual(
    retry.calls.filter((c) => c.method === "align").map((c) => (c.args as [string, string])[1])[0],
    intro.text,
  );
  assert.equal(manifest?.lines[intro.id].words[0].text, "Welcome");
  assert.equal(await isCached(dir, key, "tts.mp3"), false);
  assert.equal(await isCached(dir, key, "mp3"), true);
});

test("a new take overwrites the words an older take left behind", async (t) => {
  const { paths, log, duration } = await setup(t);
  const [intro] = narrationLines(fixture);
  const key = lineKey(intro, fixture.audio.voice.voiceId, fixture.audio.voice.modelId);
  const old = [{ text: "stale", start: 0, end: 1 }];
  const dir = paths.cacheDir("voice");
  await mkdir(dir, { recursive: true });
  await writeFile(cachePath(dir, key, "align.json"), JSON.stringify(old));
  const manifest = await runVoice(fixture, { voice: fakeVoice().voice, duration }, paths, { ...yesRun, log });
  assert.equal(manifest?.lines[intro.id].words[0].text, "Welcome");
});

test("an empty clip never reaches the cache", async (t) => {
  const { paths, log, duration } = await setup(t);
  const { voice } = fakeVoice({ sfxAudio: Buffer.alloc(0) });
  await assert.rejects(runVoice(fixture, { voice, duration }, paths, { ...yesRun, log }), /sfx open-app-0: .*empty clip/);
  const cue = sfxItems(fixture)[0];
  assert.equal(await isCached(paths.cacheDir("sfx"), sfxKey(cue.prompt, cue.sec), "mp3"), false);
});

test("a clip with no duration never reaches the cache", async (t) => {
  const { paths, log } = await setup(t);
  const { voice } = fakeVoice();
  await assert.rejects(
    runVoice(fixture, { voice, duration: async () => 0 }, paths, { ...yesRun, log }),
    /intro-1: .*no duration/,
  );
  const [intro] = narrationLines(fixture);
  const key = lineKey(intro, fixture.audio.voice.voiceId, fixture.audio.voice.modelId);
  assert.equal(await isCached(paths.cacheDir("voice"), key, "tts.mp3"), false);
  assert.equal(await isCached(paths.cacheDir("voice"), key, "mp3"), false);
});

test("a cached clip that fails to probe names the file and says to delete it", async (t) => {
  const { paths, log, duration } = await setup(t);
  await runVoice(fixture, { voice: fakeVoice().voice, duration }, paths, { ...yesRun, log });
  const broken = async () => {
    throw new Error("Invalid data");
  };
  await assert.rejects(
    runVoice(fixture, { voice: fakeVoice().voice, duration: broken }, paths, { ...yesRun, log }),
    (err: Error) => {
      assert.match(err.message, new RegExp(`${paths.cacheDir("voice")}/[0-9a-f]{64}\\.mp3`));
      assert.match(err.message, /delete it and rerun/);
      return true;
    },
  );
});

test("the resolved voice and model are printed, with built-in defaults marked", async (t) => {
  const plan = structuredClone(fixture);
  plan.audio.voice = { voiceId: "default", modelId: "default" };
  const { paths, lines, log, duration } = await setup(t);
  await runVoice(plan, { voice: fakeVoice().voice, duration }, paths, { yes: false, dryRun: true, log, env: {} });
  assert.ok(
    lines.includes(
      "voice JBFq… (built-in default; set ELEVENLABS_VOICE_ID), " +
        "model eleven_v4 (built-in default; set ELEVENLABS_MODEL_ID)",
    ),
    lines.join("\n"),
  );

  lines.length = 0;
  const env = { ELEVENLABS_VOICE_ID: "envVoice123", ELEVENLABS_MODEL_ID: "envModel" };
  await runVoice(plan, { voice: fakeVoice().voice, duration }, paths, { ...yesRun, env, log });
  assert.equal(lines[0], "voice envV… (from ELEVENLABS_VOICE_ID), model envModel (from ELEVENLABS_MODEL_ID)");

  lines.length = 0;
  await runVoice(fixture, { voice: fakeVoice().voice, duration }, paths, { ...yesRun, log });
  assert.equal(lines[0], "voice JBFq…, model eleven_v4");
});

test("a normalised alignment is logged", async (t) => {
  const { paths, lines, log, duration } = await setup(t);
  await runVoice(fixture, { voice: fakeVoice({ normalized: true }).voice, duration }, paths, { ...yesRun, log });
  assert.ok(lines.some((l) => l.startsWith("intro-1: alignment is of the normalised text")));
});

test("with lines cached, a new sfx cue or music prompt needs --yes and writes nothing", async (t) => {
  const { paths, log, duration } = await setup(t);
  await runVoice(fixture, { voice: fakeVoice().voice, duration }, paths, { ...yesRun, log });
  await rm(paths.voice);

  const moreSfx = structuredClone(fixture);
  moreSfx.audio.sfx.push({ scene: "click-through", t: 6, prompt: "ding", sec: 1 });
  for (const plan of [moreSfx, withMusic("calm piano")]) {
    const { voice, calls } = fakeVoice();
    const outcome = await runVoice(plan, { voice, duration }, paths, { yes: false, dryRun: false, log, env: {} });
    assert.equal(outcome, undefined);
    assert.deepEqual(calls, []);
    await assert.rejects(stat(paths.voice), /ENOENT/);
  }
});
