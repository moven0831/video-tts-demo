import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VFR_WARNING } from "../probe/ffprobe.ts";
import { projectPaths } from "../util/project.ts";
import { runTimeline } from "./run.ts";

const fixture = (name: string) => new URL(`../../test/fixtures/${name}`, import.meta.url).pathname;

async function project(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "timeline-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = projectPaths(join(root, "demo"));
  await mkdir(paths.build, { recursive: true });
  await copyFile(fixture("edit-plan.json"), paths.plan);
  await copyFile(fixture("probe.json"), paths.probe);
  await copyFile(fixture("voice.json"), paths.voice);
  return paths;
}

test("writes the timeline and captions for a voice.json made for the plan", async (t) => {
  const paths = await project(t);
  const warnings: string[] = [];
  const timeline = await runTimeline(paths, {}, (line) => warnings.push(line));
  assert.equal(timeline.total, 19.5);
  assert.match(await readFile(paths.captionsSrt, "utf8"), /Welcome to the product tour/);
  assert.ok((await readFile(paths.captionsVtt, "utf8")).startsWith("WEBVTT"));
  assert.deepEqual(warnings, []);
});

test("an edited line makes voice.json stale and names the voice command", async (t) => {
  const paths = await project(t);
  const plan = JSON.parse(await readFile(paths.plan, "utf8"));
  plan.chapters[0].scenes[0].narration[0].text = "Start by opening the application.";
  await writeFile(paths.plan, JSON.stringify(plan));
  await assert.rejects(
    runTimeline(paths, {}, () => {}),
    /line "open-1" changed since voice ran[\s\S]*run npm run voice -- demo --yes/,
  );
  await assert.rejects(readFile(paths.timeline, "utf8"), { code: "ENOENT" });
});

test("music added to the plan after voice ran is stale", async (t) => {
  const paths = await project(t);
  const plan = JSON.parse(await readFile(paths.plan, "utf8"));
  plan.audio.music = { prompt: "calm piano" };
  await writeFile(paths.plan, JSON.stringify(plan));
  await assert.rejects(runTimeline(paths, {}, () => {}), /music was added since voice ran/);
});

test("a VFR recording warns on every run", async (t) => {
  const paths = await project(t);
  const probe = JSON.parse(await readFile(paths.probe, "utf8"));
  await writeFile(paths.probe, JSON.stringify({ ...probe, vfr: true }));
  for (let run = 0; run < 2; run++) {
    const warnings: string[] = [];
    await runTimeline(paths, {}, (line) => warnings.push(line));
    assert.ok(warnings.includes(`warning: ${VFR_WARNING}`), `run ${run}`);
  }
});

test("a voice.json that is not a manifest names the file", async (t) => {
  const paths = await project(t);
  await writeFile(paths.voice, JSON.stringify({ lines: 1 }));
  await assert.rejects(runTimeline(paths, {}, () => {}), (err: Error) => err.message.includes(paths.voice));
});
