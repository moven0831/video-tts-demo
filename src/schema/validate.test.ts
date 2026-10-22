import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Probe } from "./artifacts.ts";
import { EditPlan } from "./edit-plan.ts";
import { clampBox, validatePlan } from "./validate.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const probe = Probe.parse(fixture("probe.json"));
const base = EditPlan.parse(fixture("edit-plan.json"));

function check(edit: (plan: EditPlan) => void) {
  const plan = structuredClone(base);
  edit(plan);
  return validatePlan(plan, probe);
}

const scene0 = (plan: EditPlan) => plan.chapters[0].scenes[0];
const scene1 = (plan: EditPlan) => plan.chapters[0].scenes[1];

test("the fixture plan has no errors or warnings", () => {
  assert.deepEqual(validatePlan(base, probe), { errors: [], warnings: [] });
});

test("warns when the plan's source differs from the probe", () => {
  const { errors, warnings } = check((p) => {
    p.meta.source.width = 1920;
    p.meta.source.fps = 60;
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /meta\.source\.width is 1920 but the recording is \d+/);
  assert.match(warnings[1], /meta\.source\.fps is 60 but the recording is/);
  assert.match(warnings[1], /replaced after planning/);
  assert.equal(check((p) => (p.meta.source.duration += 0.01)).warnings.length, 0);
  assert.equal(check((p) => (p.meta.source.duration += 1)).warnings.length, 1);
});

test("clampBox keeps a box inside the frame and drops one outside it", () => {
  assert.deepEqual(clampBox({ x: 10, y: 10, w: 20, h: 20 }, probe), { x: 10, y: 10, w: 20, h: 20 });
  assert.deepEqual(clampBox({ x: 1200, y: 700, w: 200, h: 100 }, probe), {
    x: 1200,
    y: 700,
    w: 80,
    h: 20,
  });
  assert.equal(clampBox({ x: 1280, y: 0, w: 10, h: 10 }, probe), null);
});

test("error: source in must be before out", () => {
  const { errors } = check((p) => (scene1(p).source = { in: 6, out: 6 }));
  assert.deepEqual(errors, ["chapters[0].scenes[1].source: in 6 must be before out 6"]);
});

test("error: source out past the probe duration", () => {
  const { errors } = check((p) => (scene1(p).source.out = 9));
  assert.deepEqual(errors, ["chapters[0].scenes[1].source: out 9 is past the source duration 8"]);
});

test("error: scenes overlap in source time", () => {
  const { errors } = check((p) => (scene1(p).source.in = 3));
  assert.match(errors[0], /^chapters\[0\]\.scenes\[1\]\.source: in 3 overlaps/);
  assert.equal(errors.length, 1);
});

test("error: a scene out of order reports an overlap", () => {
  const { errors } = check((p) => {
    p.chapters[0].scenes.reverse();
  });
  assert.ok(errors.some((e) => e.startsWith("chapters[0].scenes[1].source: in 0 overlaps")));
});

test("error: camera t outside the scene window", () => {
  const { errors } = check((p) => (scene0(p).camera[0].t = 5));
  assert.deepEqual(errors, ["chapters[0].scenes[0].camera[0].t: 5 is outside the scene window 0-4"]);
});

test("error: click t outside the scene window", () => {
  const { errors } = check((p) => (scene0(p).clicks[0].t = 4.5));
  assert.deepEqual(errors, ["chapters[0].scenes[0].clicks[0].t: 4.5 is outside the scene window 0-4"]);
});

test("error: narration at outside the scene window", () => {
  const { errors } = check((p) => (scene1(p).narration[0].at = 2));
  assert.deepEqual(errors, ["chapters[0].scenes[1].narration[0].at: 2 is outside the scene window 4-8"]);
});

test("a narration at inside the window passes", () => {
  const { errors } = check((p) => (scene1(p).narration[0].at = 5));
  assert.deepEqual(errors, []);
});

test("error: callout t0 and t1 outside the scene window", () => {
  const { errors } = check((p) => {
    scene0(p).callouts[0].t0 = -0.5;
    scene0(p).callouts[0].t1 = 4.5;
  });
  assert.deepEqual(errors, [
    "chapters[0].scenes[0].callouts[0].t0: -0.5 is outside the scene window 0-4",
    "chapters[0].scenes[0].callouts[0].t1: 4.5 is outside the scene window 0-4",
  ]);
});

test("error: callout t0 must be before t1", () => {
  const { errors } = check((p) => {
    scene0(p).callouts[0].t0 = 2.5;
    scene0(p).callouts[0].t1 = 2;
  });
  assert.deepEqual(errors, ["chapters[0].scenes[0].callouts[0]: t0 2.5 must be before t1 2"]);
});

test("error: duplicate scene id", () => {
  const { errors } = check((p) => (scene1(p).id = scene0(p).id));
  assert.deepEqual(errors, ['chapters[0].scenes[1]: duplicate scene id "open-app"']);
});

test("error: duplicate chapter id", () => {
  const { errors } = check((p) => {
    p.chapters.push({ ...structuredClone(p.chapters[0]), scenes: [] });
  });
  assert.deepEqual(errors, ['chapters[1]: duplicate chapter id "getting-started"']);
});

test("error: duplicate narration line id across cards and scenes", () => {
  const { errors } = check((p) => {
    assert.ok(p.outro);
    p.outro.narration[0].id = "open-1";
  });
  assert.deepEqual(errors, ['outro.narration[0]: duplicate line id "open-1"']);
});

test("error: sfx refers to a missing scene", () => {
  const { errors } = check((p) => (p.audio.sfx[0].scene = "nowhere"));
  assert.deepEqual(errors, ['audio.sfx[0].scene: no scene "nowhere"']);
});

test("error: camera box outside the frame", () => {
  const { errors } = check((p) => (scene0(p).camera[0].box = { x: 2000, y: 0, w: 100, h: 100 }));
  assert.deepEqual(errors, ["chapters[0].scenes[0].camera[0].box: box does not intersect the frame"]);
});

test("error: callout box outside the frame", () => {
  const { errors } = check((p) => (scene0(p).callouts[0].box = { x: 0, y: 800, w: 100, h: 100 }));
  assert.deepEqual(errors, ["chapters[0].scenes[0].callouts[0].box: box does not intersect the frame"]);
});

test("warning: box partly outside the frame is clamped", () => {
  const { errors, warnings } = check((p) => {
    scene0(p).callouts[0].box = { x: 1200, y: 650, w: 200, h: 200 };
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ["chapters[0].scenes[0].callouts[0].box: box clamped to the frame"]);
});

test("warning: callout window overlaps a camera move", () => {
  const { errors, warnings } = check((p) => {
    scene0(p).callouts[0].t0 = 1.2;
    scene0(p).callouts[0].t1 = 2.9;
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    "chapters[0].scenes[0].callouts[0]: window overlaps camera move camera[0]",
  ]);
});

test("a callout starting right after a camera move does not warn", () => {
  const { warnings } = check((p) => (scene0(p).callouts[0].t0 = 1.7));
  assert.deepEqual(warnings, []);
});

test("warning: narration much longer than the scene", () => {
  const { errors, warnings } = check((p) => {
    scene0(p).narration[0].text = "word ".repeat(120).trim();
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^chapters\[0\]\.scenes\[0\]\.narration: about \d+\.\d s of speech for a 4 s scene$/);
});

test("narration a little longer than the scene does not warn", () => {
  const { warnings } = check((p) => {
    scene0(p).narration[0].text = "word ".repeat(20).trim();
  });
  assert.deepEqual(warnings, []);
});

test("warning: more than two callouts visible at once", () => {
  const callout = (t0: number, t1: number) => ({
    ...structuredClone(scene1(base).callouts[0] ?? scene0(base).callouts[0]),
    t0,
    t1,
  });
  const crowd = [callout(4.5, 7), callout(5, 7), callout(5.5, 7), callout(6, 7)];
  const { errors, warnings } = check((p) => (scene1(p).callouts = crowd));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ["chapters[0].scenes[1].callouts: more than 2 visible at t=5.5"]);
});

test("two callouts visible at once do not warn", () => {
  const callout = (t0: number, t1: number) => ({ ...structuredClone(scene0(base).callouts[0]), t0, t1 });
  const { warnings } = check((p) => {
    scene1(p).callouts = [callout(4.5, 7), callout(5, 7)];
  });
  assert.deepEqual(warnings, []);
});

test("error: sfx time outside its scene's window", () => {
  const { errors } = check((p) => (p.audio.sfx[0].t = 5));
  assert.deepEqual(errors, ["audio.sfx[0].t: 5 is outside the scene window 0-4"]);
});

test("warning: music file and prompt both set", () => {
  const { errors, warnings } = check((p) => {
    p.audio.music.file = "bed.mp3";
    p.audio.music.prompt = "calm";
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [
    "audio.music: both file and prompt are set; the file is used and the prompt ignored",
  ]);
});

test("warning: a font other than Inter", () => {
  const { warnings } = check((p) => (p.style.font = "Comic Sans"));
  assert.deepEqual(warnings, [
    'style.font: only Inter is bundled, "Comic Sans" falls back to a system font',
  ]);
});
