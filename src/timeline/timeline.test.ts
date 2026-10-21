import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Probe, VoiceManifest } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { buildTimeline } from "./timeline.ts";
import { Timeline } from "./types.ts";

const probe = Probe.parse({ width: 1280, height: 720, fps: 30, duration: 60 });

type SceneInput = {
  id: string;
  source?: { in: number; out: number };
  fit?: string;
  lines?: { id: string; at?: number; pauseAfter?: number }[];
  camera?: unknown[];
  clicks?: unknown[];
  callouts?: unknown[];
};
type ChapterInput = {
  id: string;
  card?: unknown;
  scenes: SceneInput[];
  transition?: { kind: string; sec: number };
};

function planOf(
  chapters: ChapterInput[],
  extra: Record<string, unknown> = {},
  audio: Record<string, unknown> = {},
): EditPlan {
  return EditPlan.parse({
    version: 1,
    meta: {
      project: "t",
      title: "T",
      source: { width: 1280, height: 720, fps: 30, duration: 60 },
      output: { width: 1920, height: 1080, fps: 30 },
    },
    style: { captions: {}, camera: {} },
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.id,
      ...(chapter.card ? { card: chapter.card } : {}),
      ...(chapter.transition ? { transition: chapter.transition } : {}),
      scenes: chapter.scenes.map((scene) => ({
        id: scene.id,
        source: scene.source ?? { in: 0, out: 10 },
        ...(scene.fit ? { fit: scene.fit } : {}),
        narration: (scene.lines ?? []).map((line) => ({ text: "Words here.", ...line })),
        camera: scene.camera ?? [],
        clicks: scene.clicks ?? [],
        callouts: scene.callouts ?? [],
      })),
    })),
    audio: { voice: { voiceId: "v", modelId: "m" }, music: {}, sfx: [], ...audio },
    ...extra,
  });
}

// Each line id maps to its duration in seconds.
function voiceOf(durations: Record<string, number>, extra: Record<string, unknown> = {}) {
  return VoiceManifest.parse({
    lines: Object.fromEntries(
      Object.entries(durations).map(([id, duration]) => [
        id,
        { file: `${id}.mp3`, duration, words: [{ text: "Words", start: 0, end: duration }] },
      ]),
    ),
    sfx: {},
    ...extra,
  });
}

function near(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
}

function build(scene: SceneInput, durations: Record<string, number>) {
  const { timeline, warnings } = buildTimeline(
    planOf([{ id: "c", scenes: [scene] }]),
    probe,
    voiceOf(durations),
  );
  return { timeline, warnings, segment: timeline.segments[0] };
}

test("hold plays the whole source at rate 1 when speech fits", () => {
  const { segment } = build({ id: "s", fit: "hold", lines: [{ id: "a" }] }, { a: 2 });
  assert.deepEqual(
    [segment.start, segment.end, segment.in, segment.out, segment.rate, segment.freeze],
    [0, 10, 0, 10, 1, undefined],
  );
});

test("trim ends the video 0.8 s after the speech", () => {
  const { segment } = build({ id: "s", fit: "trim", lines: [{ id: "a" }] }, { a: 2 });
  near(segment.end, 0.2 + 2 + 0.35 + 0.8);
  near(segment.out, 3.35);
  assert.equal(segment.freeze, undefined);
});

test("trim never plays past the source", () => {
  const scene = { id: "s", fit: "trim", source: { in: 0, out: 3 }, lines: [{ id: "a" }] };
  const { segment } = build(scene, { a: 2 });
  near(segment.end, 3);
  near(segment.out, 3);
});

test("freeze holds the last frame for the overrun plus 0.6 s", () => {
  const scene = { id: "s", source: { in: 4, out: 6 }, lines: [{ id: "a" }] };
  const { segment } = build(scene, { a: 2 });
  near(segment.end, 0.55 + 2 + 0.6);
  assert.equal(segment.rate, 1);
  near(segment.freeze?.start, 2);
  near(segment.freeze?.duration, 0.55 + 0.6);
  near(segment.freeze?.at, 6 - 1 / 30);
});

test("freeze.at is the source time of the last frame the video plays, at any frame rate", () => {
  for (const fps of [24, 30, 60, 30000 / 1001]) {
    const scene = { id: "s", source: { in: 4.05, out: 6.3 }, lines: [{ id: "a" }] };
    const { timeline } = buildTimeline(
      planOf([{ id: "c", scenes: [scene] }]),
      Probe.parse({ ...probe, fps }),
      voiceOf({ a: 4 }),
    );
    const at = timeline.segments[0].freeze?.at ?? NaN;
    assert.equal(Math.round(at * fps), Math.ceil(6.3 * fps - 1e-6) - 1, `fps ${fps}`);
    assert.ok(at < 6.3 && at >= 6.3 - 1 / fps - 1e-5, `fps ${fps}`);
  }
});

test("a freeze over 6 s warns", () => {
  const scene = { id: "s", source: { in: 0, out: 1 }, lines: [{ id: "a" }] };
  const { warnings, segment } = build(scene, { a: 8 });
  near(segment.freeze?.duration, 7.55 + 0.6);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /scene "s" freezes the last frame for 8\.\d s/);
});

test("a freeze of 6 s or less does not warn", () => {
  const scene = { id: "s", source: { in: 0, out: 2 }, lines: [{ id: "a" }] };
  assert.deepEqual(build(scene, { a: 6 }).warnings, []);
});

test("slow stretches the source to the speech when rate stays above 0.5", () => {
  const scene = { id: "s", fit: "slow", source: { in: 0, out: 4 }, lines: [{ id: "a" }] };
  const { segment } = build(scene, { a: 4 });
  near(segment.rate, 4 / 4.55);
  near(segment.end, 4.55);
  near(segment.out, 4);
  assert.equal(segment.freeze, undefined);
});

test("slow floors the rate at 0.5 and freezes the remainder", () => {
  const scene = { id: "s", fit: "slow", source: { in: 0, out: 2 }, lines: [{ id: "a" }] };
  const { segment } = build(scene, { a: 4 });
  near(segment.rate, 0.5);
  near(segment.end, 4.55);
  near(segment.freeze?.start, 4);
  near(segment.freeze?.duration, 0.55);
});

test("freeze and slow behave like hold when speech fits", () => {
  for (const fit of ["freeze", "slow"]) {
    const { segment } = build({ id: "s", fit, lines: [{ id: "a" }] }, { a: 2 });
    assert.deepEqual(
      [segment.end, segment.rate, segment.freeze],
      [10, 1, undefined],
      fit,
    );
  }
});

test("hold and trim fall back to a freeze when speech overruns the source", () => {
  for (const fit of ["hold", "trim"]) {
    const scene = { id: "s", fit, source: { in: 0, out: 2 }, lines: [{ id: "a" }] };
    near(build(scene, { a: 2 }).segment.freeze?.duration, 1.15);
  }
});

test("narration starts after the lead-in and lines follow with pauseAfter", () => {
  const scene = {
    id: "s",
    lines: [{ id: "a", pauseAfter: 0.5 }, { id: "b" }],
  };
  const { timeline } = build(scene, { a: 1, b: 2 });
  near(timeline.narration[0].start, 0.2);
  near(timeline.narration[1].start, 0.2 + 1 + 0.5);
});

test("`at` is a lower bound for the line start", () => {
  const scene = { id: "s", lines: [{ id: "a", at: 3 }, { id: "b" }] };
  const { timeline } = build(scene, { a: 1, b: 1 });
  near(timeline.narration[0].start, 3);
  near(timeline.narration[1].start, 3 + 1 + 0.35);
});

test("`at` earlier than the natural start does not pull a line forward", () => {
  const scene = { id: "s", lines: [{ id: "a" }, { id: "b", at: 0.1 }] };
  const { timeline } = build(scene, { a: 1, b: 1 });
  near(timeline.narration[1].start, 0.2 + 1 + 0.35);
});

test("`at` maps through the playback rate", () => {
  const scene = {
    id: "s",
    fit: "slow",
    source: { in: 10, out: 12 },
    lines: [{ id: "a", at: 11 }],
  };
  const { timeline, segment } = build(scene, { a: 4 });
  // Rate 0.5: one source second takes two output seconds.
  near(timeline.narration[0].start, 2);
  near(segment.end, 2 + 4 + 0.35);
  near(segment.freeze?.duration, 6.35 - 4);
});

test("a scene grows when `at` pushes narration past its end", () => {
  const scene = { id: "s", source: { in: 0, out: 3 }, lines: [{ id: "a", at: 2.5 }] };
  const { timeline, segment } = build(scene, { a: 1 });
  near(timeline.narration[0].start, 2.5);
  // Speech now ends at 3.85, past the 3 s source: freeze for 0.85 + 0.6.
  near(segment.end, 3.85 + 0.6);
  near(segment.freeze?.duration, 0.85 + 0.6);
});

test("lines never overlap even when `at` values collide", () => {
  const scene = { id: "s", lines: [{ id: "a", at: 1 }, { id: "b", at: 1.5 }, { id: "c", at: 1.6 }] };
  const { timeline } = build(scene, { a: 2, b: 2, c: 2 });
  const [a, b, c] = timeline.narration;
  assert.ok(b.start >= a.start + a.duration);
  assert.ok(c.start >= b.start + b.duration);
});

const card = { kind: "title", title: "T", narration: [{ id: "a", text: "Hello." }] };

test("a card lasts its sec when narration is shorter", () => {
  const { timeline } = buildTimeline(
    planOf([{ id: "c", scenes: [{ id: "s" }] }], { intro: { ...card, sec: 5 } }),
    probe,
    voiceOf({ a: 2 }),
  );
  assert.equal(timeline.cards[0].duration, 5);
  near(timeline.narration[0].start, 0.2);
});

test("a card stretches to narration plus lead-in, pause and 0.6 s", () => {
  const { timeline } = buildTimeline(
    planOf([{ id: "c", scenes: [{ id: "s" }] }], { intro: { ...card, sec: 3 } }),
    probe,
    voiceOf({ a: 4 }),
  );
  near(timeline.cards[0].duration, 0.2 + 4 + 0.35 + 0.6);
  near(timeline.segments[0].start, 5.15);
});

test("items run intro, chapter card, scenes, outro", () => {
  const plan = planOf(
    [
      {
        id: "chap",
        card: { kind: "chapter", title: "Chap", sec: 2 },
        scenes: [{ id: "s1", source: { in: 0, out: 3 } }, { id: "s2", source: { in: 3, out: 5 } }],
      },
    ],
    { intro: { kind: "title", title: "In", sec: 1 }, outro: { kind: "outro", title: "Out", sec: 1.5 } },
  );
  const { timeline } = buildTimeline(plan, probe, voiceOf({}));
  assert.deepEqual(
    timeline.cards.map((c) => [c.id, c.start, c.duration]),
    [
      ["intro", 0, 1],
      ["chapter-chap", 1, 2],
      ["outro", 8, 1.5],
    ],
  );
  assert.deepEqual(
    timeline.segments.map((s) => [s.scene, s.start, s.end]),
    [
      ["s1", 3, 6],
      ["s2", 6, 8],
    ],
  );
  assert.equal(timeline.total, 9.5);
});

function twoChapters(transition?: { kind: string; sec: number }) {
  const plan = planOf([
    { id: "a", scenes: [{ id: "s1", source: { in: 0, out: 4 } }], transition },
    { id: "b", scenes: [{ id: "s2", source: { in: 4, out: 7 } }] },
  ]);
  return buildTimeline(plan, probe, voiceOf({}));
}

test("cut adds no time", () => {
  const { timeline } = twoChapters({ kind: "cut", sec: 0 });
  assert.deepEqual(timeline.transitions, [{ kind: "cut", at: 4, duration: 0 }]);
  assert.equal(timeline.segments[1].start, 4);
  assert.equal(timeline.total, 7);
});

test("fade-black inserts a gap that adds to the total", () => {
  const { timeline } = twoChapters({ kind: "fade-black", sec: 0.5 });
  assert.deepEqual(timeline.transitions, [{ kind: "fade-black", at: 4, duration: 0.5 }]);
  assert.equal(timeline.segments[1].start, 4.5);
  assert.equal(timeline.total, 7.5);
});

test("dissolve overlaps the next item and shrinks the total", () => {
  const { timeline } = twoChapters({ kind: "dissolve", sec: 0.5 });
  assert.deepEqual(timeline.transitions, [{ kind: "dissolve", at: 3.5, duration: 0.5 }]);
  assert.equal(timeline.segments[1].start, 3.5);
  assert.equal(timeline.total, 6.5);
});

test("push acts as dissolve and warns", () => {
  const { timeline, warnings } = twoChapters({ kind: "push", sec: 0.5 });
  assert.deepEqual(timeline.transitions, [{ kind: "push", at: 3.5, duration: 0.5 }]);
  assert.equal(timeline.total, 6.5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /push/);
});

test("a transition after the last chapter with no outro is dropped", () => {
  const plan = planOf([
    { id: "a", scenes: [{ id: "s1", source: { in: 0, out: 4 } }], transition: { kind: "fade-black", sec: 1 } },
  ]);
  const { timeline } = buildTimeline(plan, probe, voiceOf({}));
  assert.deepEqual(timeline.transitions, []);
  assert.equal(timeline.total, 4);
});

test("a dissolve that makes narration overlap warns", () => {
  const plan = planOf([
    {
      id: "a",
      scenes: [{ id: "s1", source: { in: 0, out: 3 }, lines: [{ id: "x", pauseAfter: 0 }] }],
      transition: { kind: "dissolve", sec: 2 },
    },
    { id: "b", scenes: [{ id: "s2", source: { in: 3, out: 6 }, lines: [{ id: "y" }] }] },
  ]);
  const { warnings } = buildTimeline(plan, probe, voiceOf({ x: 2.7, y: 1 }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"y"/);
});

test("clicks and callouts map through the rate and clamp at the video end", () => {
  const scene = {
    id: "s",
    fit: "slow",
    source: { in: 0, out: 2 },
    lines: [{ id: "a" }],
    clicks: [{ t: 1, x: 640, y: 360 }],
    callouts: [{ t0: 1, t1: 2, box: { x: 100, y: 200, w: 300, h: 80 }, label: "L" }],
  };
  const { timeline } = build(scene, { a: 4 });
  assert.deepEqual(timeline.clicks, [{ t: 2, x: 960, y: 540, kind: "click" }]);
  assert.deepEqual(timeline.callouts[0].box, { x: 150, y: 300, w: 450, h: 120 });
  near(timeline.callouts[0].t0, 2);
  near(timeline.callouts[0].t1, 4);
});

test("times after a freeze do not drift: the video part is mapped, not the freeze", () => {
  const scene = {
    id: "s",
    source: { in: 5, out: 7 },
    lines: [{ id: "a" }],
    clicks: [{ t: 6, x: 0, y: 0 }],
    callouts: [{ t0: 6, t1: 7, box: { x: 0, y: 0, w: 10, h: 10 }, label: "L" }],
  };
  const { timeline, segment } = build(scene, { a: 4 });
  near(segment.freeze?.start, 2);
  near(timeline.clicks[0].t, 1);
  near(timeline.callouts[0].t1, 2);
});

test("camera keyframes use output times and the plan's camera style", () => {
  const plan = planOf([
    {
      id: "a",
      scenes: [
        {
          id: "s",
          source: { in: 10, out: 14 },
          camera: [
            { t: 13, box: null },
            { t: 11, box: { x: 640, y: 180, w: 480, h: 270 } },
          ],
        },
      ],
    },
  ]);
  const { timeline } = buildTimeline(plan, probe, voiceOf({}));
  assert.deepEqual(
    timeline.camera.map((k) => [k.t, k.scale, k.x, k.y, k.duration]),
    [
      [1, 2.4, -2208, -594, 0.7],
      [3, 1, 0, 0, 0.7],
    ],
  );
});

const zoomBox = { x: 640, y: 180, w: 480, h: 270 };

function zoomedChapter(
  transition: { kind: string; sec: number } | undefined,
  next: Partial<ChapterInput> = {},
  key: unknown = { t: 1, box: zoomBox },
) {
  const plan = planOf([
    { id: "a", scenes: [{ id: "s1", source: { in: 0, out: 4 }, camera: [key] }], transition },
    { id: "b", scenes: [{ id: "s2", source: { in: 4, out: 7 } }], ...next },
  ]);
  return buildTimeline(plan, probe, voiceOf({}));
}

test("a chapter card resets a zoomed camera with an instant key", () => {
  const { timeline, warnings } = zoomedChapter(undefined, {
    card: { kind: "chapter", title: "B", sec: 2 },
  });
  assert.deepEqual(
    timeline.camera.map((k) => [k.t, k.scale, k.x, k.y, k.duration]),
    [
      [1, 2.4, -2208, -594, 0.7],
      [4, 1, 0, 0, 0],
    ],
  );
  assert.deepEqual(warnings, []);
});

test("the middle of a fade-black gap resets a zoomed camera", () => {
  const { timeline, warnings } = zoomedChapter({ kind: "fade-black", sec: 1 });
  assert.deepEqual(
    timeline.camera.map((k) => [k.t, k.scale, k.duration]),
    [
      [1, 2.4, 0.7],
      [4.5, 1, 0],
    ],
  );
  assert.deepEqual(warnings, []);
});

test("a dissolve into a card resets the camera once the card is opaque", () => {
  for (const kind of ["dissolve", "push"]) {
    const { timeline } = zoomedChapter(
      { kind, sec: 0.5 },
      { card: { kind: "chapter", title: "B", sec: 2 } },
    );
    assert.equal(timeline.cards[0].start, 3.5, kind);
    assert.deepEqual(
      timeline.camera.map((k) => [k.t, k.duration]),
      [
        [1, 0.7],
        [4, 0],
      ],
      kind,
    );
  }
});

test("no reset key is added when the camera is already at full frame", () => {
  const withCard = { card: { kind: "chapter", title: "B", sec: 2 } };
  assert.equal(zoomedChapter(undefined, withCard, { t: 1, box: null }).timeline.camera.length, 1);
  const fade = zoomedChapter({ kind: "fade-black", sec: 1 }, {}, { t: 1, box: null });
  assert.equal(fade.timeline.camera.length, 1);
});

test("a zoomed chapter reaching a scene without a card or fade warns", () => {
  for (const kind of ["cut", "dissolve", "push"]) {
    const { timeline, warnings } = zoomedChapter({ kind, sec: 0.5 });
    assert.equal(timeline.camera.length, 1, kind);
    const warning = warnings.find((w) => w.includes("zoomed"));
    assert.match(warning ?? "", /chapter "a" ends zoomed in; add a box: null camera key/, kind);
  }
});

test("an at-rest chapter reaching a scene by cut does not warn", () => {
  const { warnings } = zoomedChapter({ kind: "cut", sec: 0 }, {}, { t: 1, box: null });
  assert.deepEqual(warnings, []);
});

test("sfx get scene-index ids and mapped start times", () => {
  const plan = planOf(
    [{ id: "a", scenes: [{ id: "s", source: { in: 2, out: 8 } }, { id: "u", source: { in: 8, out: 9 } }] }],
    {},
    {
      sfx: [
        { scene: "s", t: 3, prompt: "p", sec: 0.5 },
        { scene: "u", t: 8.5, prompt: "p", sec: 0.5 },
        { scene: "s", t: 5, prompt: "p", sec: 0.5 },
      ],
    },
  );
  const voice = VoiceManifest.parse({
    lines: {},
    sfx: {
      "s-0": { file: "s-0.mp3", duration: 0.5 },
      "s-1": { file: "s-1.mp3", duration: 0.5 },
      "u-0": { file: "u-0.mp3", duration: 0.7 },
    },
  });
  const { timeline } = buildTimeline(plan, probe, voice);
  assert.deepEqual(
    timeline.sfx.map((s) => [s.id, s.file, s.start, s.duration]),
    [
      ["s-0", "s-0.mp3", 1, 0.5],
      ["s-1", "s-1.mp3", 3, 0.5],
      ["u-0", "u-0.mp3", 6.5, 0.7],
    ],
  );
});

test("music comes from voice.json and carries a ducking lane", () => {
  const scene = { id: "s", lines: [{ id: "a" }] };
  const plan = planOf([{ id: "c", scenes: [scene] }], {}, { music: { file: "bed.mp3" } });
  const voice = voiceOf({ a: 2 }, { music: { file: "../music/bed.mp3", duration: 30 } });
  const { timeline, warnings } = buildTimeline(plan, probe, voice);
  assert.equal(timeline.music?.file, "../music/bed.mp3");
  assert.equal(timeline.music?.gainDb, -18);
  assert.deepEqual(timeline.music?.lane[0], { t: 0, db: -18 });
  assert.ok(timeline.music?.lane.some((p) => p.db === -30));
  assert.deepEqual(warnings, []);

  const none = buildTimeline(planOf([{ id: "c", scenes: [scene] }]), probe, voiceOf({ a: 2 }));
  assert.equal(none.timeline.music, undefined);
  assert.deepEqual(none.warnings, []);
});

test("music named in the plan but missing from voice.json warns and is left out", () => {
  const scene = { id: "s", lines: [{ id: "a" }] };
  for (const music of [{ file: "bed.mp3" }, { prompt: "calm piano" }]) {
    const plan = planOf([{ id: "c", scenes: [scene] }], {}, { music });
    const { timeline, warnings } = buildTimeline(plan, probe, voiceOf({ a: 2 }));
    assert.equal(timeline.music, undefined);
    assert.deepEqual(warnings, [
      "music is set in the plan but not in voice.json; rerun npm run voice",
    ]);
  }
});

test("a chapter named intro or outro does not collide with those cards", () => {
  const plan = planOf(
    [
      { id: "intro", card: { kind: "chapter", title: "C", sec: 1 }, scenes: [{ id: "s1" }] },
      { id: "outro", card: { kind: "chapter", title: "D", sec: 1 }, scenes: [{ id: "s2" }] },
    ],
    { intro: { kind: "title", title: "In", sec: 1 }, outro: { kind: "outro", title: "Out", sec: 1 } },
  );
  const { timeline } = buildTimeline(plan, probe, voiceOf({}));
  const ids = timeline.cards.map((c) => c.id);
  assert.deepEqual(ids, ["intro", "chapter-intro", "chapter-outro", "outro"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("a missing voice line or sfx entry throws", () => {
  const plan = planOf([{ id: "c", scenes: [{ id: "s", lines: [{ id: "a" }] }] }]);
  assert.throws(() => buildTimeline(plan, probe, voiceOf({})), /no line "a"/);
  const withSfx = planOf([{ id: "c", scenes: [{ id: "s" }] }], {}, {
    sfx: [{ scene: "s", t: 1, prompt: "p", sec: 1 }],
  });
  assert.throws(() => buildTimeline(withSfx, probe, voiceOf({})), /no sfx "s-0"/);
});

test("captions carry output times and stay inside the total", () => {
  const scene = { id: "s", fit: "hold", lines: [{ id: "a" }] };
  const { timeline } = build(scene, { a: 2 });
  assert.equal(timeline.captions.length, 1);
  near(timeline.captions[0].start, 0.2);
  near(timeline.captions[0].end, 0.2 + 2.6);
});

const fixture = (name: string) => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

test("the fixture timeline matches the golden file", async () => {
  const [plan, fixtureProbe, voice] = await Promise.all(
    ["edit-plan.json", "probe.json", "voice.json"].map(async (name) =>
      JSON.parse(await readFile(fixture(name), "utf8")),
    ),
  );
  const { timeline, warnings } = buildTimeline(
    EditPlan.parse(plan),
    Probe.parse(fixtureProbe),
    VoiceManifest.parse(voice),
  );
  assert.deepEqual(warnings, []);
  Timeline.parse(timeline);

  const golden = fixture("timeline.golden.json");
  const text = `${JSON.stringify(timeline, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN) await writeFile(golden, text);
  assert.equal(text, await readFile(golden, "utf8"));
});
