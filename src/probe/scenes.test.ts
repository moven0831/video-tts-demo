import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { run } from "../util/exec.ts";
import { detectScenes, parseScenes } from "./scenes.ts";

const skip = spawnSync("ffmpeg", ["-version"]).error ? "ffmpeg is not installed" : false;

// Captured from ffmpeg 8.1 on red 1 s, blue 1 s, green 1 s at 10 fps.
const capture = `frame:0    pts:10240   pts_time:1
lavfi.scene_score=0.400000
frame:1    pts:20480   pts_time:2
lavfi.scene_score=0.400000
`;

test("parses cut times and scores", () => {
  assert.deepEqual(parseScenes(capture), [
    { t: 1, score: 0.4 },
    { t: 2, score: 0.4 },
  ]);
});

test("no output means no cuts", () => {
  assert.deepEqual(parseScenes(""), []);
});

test("detects the hard cut of a real clip", { skip }, async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "scenes-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cut.mp4");
  await run("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:d=1:r=10"],
    ...["-f", "lavfi", "-i", "color=blue:s=160x90:d=1:r=10"],
    ...["-filter_complex", "concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", file],
  ]);
  const cuts = await detectScenes(file);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].t, 1);
});
