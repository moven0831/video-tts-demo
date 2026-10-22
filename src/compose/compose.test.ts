import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { EditPlan } from "../schema/edit-plan.ts";
import { Timeline } from "../timeline/types.ts";
import { compose } from "./compose.ts";
import { pickSide } from "./templates/overlay.ts";

const fixture = (name: string) => new URL(`../../test/fixtures/${name}`, import.meta.url);
const timeline = Timeline.parse(JSON.parse(await readFile(fixture("timeline.golden.json"), "utf8")));
const plan = EditPlan.parse(JSON.parse(await readFile(fixture("edit-plan.json"), "utf8")));

test("index.html matches the golden file", async () => {
  const html = compose(timeline, plan).files["index.html"];
  if (process.env.UPDATE_GOLDEN) await writeFile(fixture("expected-index.html"), html);
  assert.equal(html, await readFile(fixture("expected-index.html"), "utf8"));
});

test("root duration equals the timeline total", () => {
  const html = compose(timeline, plan).files["index.html"];
  assert.match(html, /data-composition-id="demo" data-start="0" data-duration="19.5"/);
  assert.match(html, /window\.__timelines\["demo"\] = tl/);
});

test("every video is muted and carries data-media-start", () => {
  const html = compose(timeline, plan).files["index.html"];
  const videos = html.match(/<video [^>]*>/g) ?? [];
  assert.equal(videos.length, timeline.segments.length);
  for (const tag of videos) {
    assert.match(tag, / muted /);
    assert.match(tag, /data-media-start="/);
  }
});

test("segments with a freeze emit a still and shorten the video", () => {
  const result = compose(timeline, plan);
  assert.deepEqual(result.stills, [
    { scene: "open-app", mediaStart: 0, at: 3.966667, to: "assets/freeze-open-app.png" },
  ]);
  const html = result.files["index.html"];
  assert.match(html, /<video id="vid-open-app"[^>]*data-start="6.55" data-duration="4"/);
  assert.match(html, /<img id="frz-open-app"[^>]*data-start="10.55" data-duration="1.1"/);
});

test("card hosts match their files and are static", () => {
  const result = compose(timeline, plan);
  const html = result.files["index.html"];
  for (const card of timeline.cards) {
    const host = html.match(new RegExp(`<div id="card-${card.id}"[^>]*>`))?.[0] ?? "";
    assert.match(host, new RegExp(`data-composition-id="${card.id}"`));
    assert.match(host, new RegExp(`data-composition-src="compositions/cards/${card.id}.html"`));
    assert.match(host, / data-no-timeline>/);
    const file = result.files[`compositions/cards/${card.id}.html`];
    assert.match(file, new RegExp(`<div data-composition-id="${card.id}" `));
  }
});

test("copies cover input, vendored files and audio", () => {
  const { copies } = compose(timeline, plan);
  const to = copies.map((c) => c.to);
  assert.ok(to.includes("assets/input.mp4"));
  assert.ok(to.includes("assets/gsap.min.js"));
  assert.ok(to.includes("assets/fonts/inter-700.woff2"));
  assert.ok(to.includes("assets/audio/intro-1.mp3"));
  assert.ok(to.includes("assets/audio/open-app-0.mp3"));
});

test("captions burn in only when enabled", () => {
  const on = compose(timeline, plan).files["index.html"];
  assert.equal((on.match(/class="cap clip"/g) ?? []).length, timeline.captions.length);
  const off = compose(timeline, {
    ...plan,
    style: { ...plan.style, captions: { ...plan.style.captions, mode: "off" } },
  }).files["index.html"];
  assert.doesNotMatch(off, /class="cap clip"/);
});

test("plan text is escaped", () => {
  const hostile = "<b>&\"x\"";
  const tl: Timeline = {
    ...timeline,
    cards: timeline.cards.map((c) => ({ ...c, title: hostile, subtitle: hostile })),
    callouts: timeline.callouts.map((c) => ({ ...c, label: hostile })),
    captions: timeline.captions.map((c) => ({ ...c, lines: [hostile] })),
  };
  const pl: EditPlan = {
    ...plan,
    meta: { ...plan.meta, title: hostile },
    chapters: plan.chapters.map((c) => ({ ...c, title: hostile })),
  };
  const result = compose(tl, pl);
  for (const text of Object.values(result.files)) {
    assert.doesNotMatch(text, /<b>/);
    assert.match(text, /&lt;b&gt;&amp;&quot;x&quot;/);
  }
});

test("a hostile font name cannot close the style tag or open a script", () => {
  const font = 'x"; }</style><script>alert(1)</script>';
  const tags = (text: string) => [/<\/style>/g, /<script/g].map((re) => text.match(re)?.length ?? 0);
  const plain = compose(timeline, plan).files;
  const hostile = compose(timeline, { ...plan, style: { ...plan.style, font } }).files;
  for (const [name, text] of Object.entries(hostile)) {
    assert.deepEqual(tags(text), tags(plain[name]), name);
    assert.doesNotMatch(text, /alert\(1\)/, name);
  }
});

test("music lane becomes a volume automation in linear gain", () => {
  const tl: Timeline = {
    ...timeline,
    music: {
      file: "cache/music/m.mp3",
      gainDb: -20,
      lane: [
        { t: 0, db: -20 },
        { t: 2, db: -20 },
        { t: 2.3, db: -32 },
      ],
    },
  };
  const html = compose(tl, plan).files["index.html"];
  const attr = html.match(/<audio id="music"[^>]*data-automation="([^"]*)"/)?.[1] ?? "";
  const lane = JSON.parse(attr.replaceAll("&quot;", '"'));
  assert.deepEqual(lane.lanes[0].points, [
    { t: 0, v: 0.1 },
    { t: 2, v: 0.1 },
    { t: 2.3, v: 0.025 },
  ]);
});

test("push falls back to dissolve with a warning", () => {
  const tl: Timeline = { ...timeline, transitions: [{ kind: "push", start: 3, duration: 0.5 }] };
  assert.match(compose(tl, plan).warnings[0], /push/);
});

test("auto side picks the roomiest edge", () => {
  const stage = { width: 1920, height: 1080 };
  assert.equal(pickSide({ x: 800, y: 900, w: 300, h: 100 }, stage), "top");
  assert.equal(pickSide({ x: 100, y: 100, w: 300, h: 100 }, stage), "right");
});
