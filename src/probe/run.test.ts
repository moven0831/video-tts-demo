import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Motion, Probe, SceneCuts } from "../schema/artifacts.ts";
import { run } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { projectPaths } from "../util/project.ts";
import { runProbe } from "./run.ts";

const skip = spawnSync("ffmpeg", ["-version"]).error ? "ffmpeg is not installed" : false;

test("probes a 6 s clip and skips an unchanged rerun", { skip }, async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "probe-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = projectPaths(join(dir, "demo"));
  await mkdir(paths.root);
  await run("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=6:r=15"],
    ...["-pix_fmt", "yuv420p", paths.input],
  ]);

  assert.equal(await runProbe(paths, { force: false }), "done");
  const probe = await readJson(paths.probe, Probe);
  assert.deepEqual([probe.width, probe.height, probe.fps], [640, 360, 15]);
  assert.ok(Math.abs(probe.duration - 6) < 0.1);
  await readJson(paths.scenes, SceneCuts);
  assert.equal((await readJson(paths.motion, Motion)).boxes.length, 6);
  assert.equal((await readdir(paths.frames)).length, 6);
  const index = JSON.parse(await readFile(join(paths.sheets, "index.json"), "utf8"));
  assert.equal(index.length, 1);
  assert.equal(index[0].tiles.length, 6);
  await stat(join(paths.build, index[0].file));
  await stat(paths.contact);

  assert.equal(await runProbe(paths, { force: false }), "skipped");
  assert.equal(await runProbe(paths, { force: true }), "done");
});
