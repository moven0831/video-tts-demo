import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Probe } from "../schema/artifacts.ts";
import { run } from "../util/exec.ts";
import { stillFrame, stillIndex, writeStill } from "./write.ts";

const skip = spawnSync("ffmpeg", ["-version"]).error ? "ffmpeg is not installed" : false;

test("the still is the frame index the timeline's freeze.at names, at any frame rate", () => {
  for (const fps of [24, 30, 60, 30000 / 1001]) {
    for (const index of [0, 1, 179, 1439]) {
      assert.equal(stillFrame(index / fps, fps, 120), index, `fps ${fps} frame ${index}`);
    }
  }
});

test("the still never goes past the last frame of the file", () => {
  assert.equal(stillFrame(10, 30, 2), 59);
});

test("the still never goes past the video stream's last frame", () => {
  assert.equal(stillFrame(1.99, 30, 2, 58), 57);
  assert.equal(stillFrame(1, 30, 2, 58), 30);
});

test("the still index uses the probe's frame rate and frame count", () => {
  const probe = Probe.parse({ width: 10, height: 10, fps: 60000 / 1001, duration: 10, frames: 100 });
  assert.equal(stillIndex(50 / probe.fps, probe), 50);
  assert.equal(stillIndex(9, probe), 99);
});

test("a still past the end of the video throws, naming the scene and time", { skip }, async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "still-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "in.mp4");
  await run("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:d=1:r=10"],
    ...["-pix_fmt", "yuv420p", input],
  ]);

  const png = join(dir, "ok.png");
  await writeStill(input, png, 5, "bt709", { scene: "open", at: 0.5 });
  assert.ok((await stat(png)).size > 0);

  await assert.rejects(
    writeStill(input, join(dir, "late.png"), 500, "bt709", { scene: "open", at: 50 }),
    /freeze frame for scene "open" at 50 s/,
  );
});
