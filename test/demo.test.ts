import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/util/exec.ts";
import { capture } from "../src/render/spawn.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules/.bin/tsx");

async function ffmpegMissing(): Promise<string | false> {
  try {
    await run("ffmpeg", ["-version"]);
    return false;
  } catch {
    return "ffmpeg is not installed";
  }
}

test("demo without --yes probes, checks the plan, shows the voice spend and stops", {
  skip: await ffmpegMissing(),
  timeout: 120_000,
}, async (t) => {
  const dir = join(await mkdtemp(join(tmpdir(), "demo-")), "proj");
  t.after(() => rm(join(dir, ".."), { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "input.mp4"),
  ]);
  await copyFile(join(ROOT, "test/fixtures/edit-plan.json"), join(dir, "edit-plan.json"));

  const { stdout, stderr, code } = await capture(TSX, [join(ROOT, "src/cli/demo.ts"), dir], {
    env: { ELEVENLABS_API_KEY: "" },
  });

  assert.equal(code, 1, stderr);
  assert.match(stdout, /run probe/);
  assert.match(stdout, /run plan-check/);
  assert.match(stdout, /lines: 5, characters: 145, uncached characters: 145/);
  assert.match(stdout, /pass --yes to generate/);
  assert.match(stderr, /rerun with --yes/);
  await assert.rejects(access(join(dir, "build/voice.json")));
  assert.match(await readFile(join(dir, "build/probe.hash"), "utf8"), /^[0-9a-f]{64}$/);
});
