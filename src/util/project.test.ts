import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseProjectArgs, projectPaths } from "./project.ts";

test("a bare name resolves under projects/ in the cwd", () => {
  const paths = projectPaths("demo");
  assert.equal(paths.root, resolve("projects", "demo"));
  assert.equal(paths.name, "demo");
});

test("an argument with a slash is resolved as given", () => {
  const paths = projectPaths("/tmp/x/my-proj");
  assert.equal(paths.root, "/tmp/x/my-proj");
  assert.equal(paths.name, "my-proj");
  assert.equal(projectPaths("./rel/p").root, resolve("rel", "p"));
});

test("every path sits where the layout puts it", () => {
  const p = projectPaths("/r/p");
  assert.equal(p.input, "/r/p/input.mp4");
  assert.equal(p.brief, "/r/p/brief.md");
  assert.equal(p.plan, "/r/p/edit-plan.json");
  assert.equal(p.music, "/r/p/music");
  assert.equal(p.probe, "/r/p/build/probe.json");
  assert.equal(p.scenes, "/r/p/build/scenes.json");
  assert.equal(p.motion, "/r/p/build/motion.json");
  assert.equal(p.frames, "/r/p/build/frames");
  assert.equal(p.sheets, "/r/p/build/sheets");
  assert.equal(p.contact, "/r/p/build/contact.jpg");
  assert.equal(p.cache, "/r/p/build/cache");
  assert.equal(p.voice, "/r/p/build/voice.json");
  assert.equal(p.timeline, "/r/p/build/timeline.json");
  assert.equal(p.captionsSrt, "/r/p/build/captions.srt");
  assert.equal(p.captionsVtt, "/r/p/build/captions.vtt");
  assert.equal(p.hf, "/r/p/build/hf");
  assert.equal(p.render, "/r/p/build/render.mp4");
  assert.equal(p.out, "/r/p/out");
  assert.equal(p.final, "/r/p/out/final.mp4");
  assert.equal(p.finalSrt, "/r/p/out/final.srt");
  assert.equal(p.finalVtt, "/r/p/out/final.vtt");
  assert.equal(p.finalContact, "/r/p/out/contact.jpg");
});

test("sheets index and the rejected plan live in build/", () => {
  const p = projectPaths("/r/p");
  assert.equal(p.sheetsIndex, "/r/p/build/sheets/index.json");
  assert.equal(p.planRejected, "/r/p/build/plan.rejected.json");
});

test("stageHash and cacheDir build on the build dir", () => {
  const p = projectPaths("/r/p");
  assert.equal(p.stageHash("voice"), join("/r/p/build", "voice.hash"));
  assert.equal(p.demoHash("mux"), join("/r/p/build", "mux.demo.hash"));
  assert.equal(p.cacheDir("sfx"), "/r/p/build/cache/sfx");
});

test("parseProjectArgs takes one positional and returns flag values", () => {
  const { paths, values } = parseProjectArgs(["demo", "--yes", "--model", "m"], {
    yes: { type: "boolean" },
    model: { type: "string" },
  });
  assert.equal(paths.name, "demo");
  assert.equal(values.yes, true);
  assert.equal(values.model, "m");
});

test("flags may come before the project", () => {
  const { paths, values } = parseProjectArgs(["--draft", "demo"], { draft: { type: "boolean" } });
  assert.equal(paths.name, "demo");
  assert.equal(values.draft, true);
});

test("parseProjectArgs rejects zero or several positionals", () => {
  assert.throws(() => parseProjectArgs([], {}), /expected one project/);
  assert.throws(() => parseProjectArgs(["a", "b"], {}), /expected one project/);
});

test("parseProjectArgs rejects unknown flags", () => {
  assert.throws(() => parseProjectArgs(["demo", "--nope"], {}));
});
