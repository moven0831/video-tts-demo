import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VoiceManifest } from "../src/schema/artifacts.ts";
import { Timeline } from "../src/timeline/types.ts";
import { run } from "../src/util/exec.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules/.bin/tsx");
const HF = join(ROOT, "node_modules/.bin/hyperframes");
const fixture = (name: string) => join(ROOT, "test/fixtures", name);

async function skipReason(): Promise<string | false> {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    return "ffmpeg is not installed";
  }
  try {
    await run(HF, ["browser", "path"], {
      env: { HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_SKIP_SKILLS: "1" },
    });
  } catch {
    return "the HyperFrames browser is not installed (npx hyperframes browser ensure)";
  }
  return false;
}

async function probe(file: string, args: string[]): Promise<string> {
  return (await run("ffprobe", ["-v", "error", ...args, file])).stdout.trim();
}

async function meanLuma(video: string, at: number): Promise<number> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-ss", String(at), "-i", video, "-frames:v", "1",
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-",
  ]);
  const match = stdout.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  assert.ok(match, `no luma reading at ${at}s`);
  return Number(match[1]);
}

const reason = await skipReason();

test("probe, timeline, compose, render and mux produce a finished video", { skip: reason, timeout: 240_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const build = join(dir, "build");
  await mkdir(build, { recursive: true });

  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "input.mp4"),
  ]);
  await copyFile(fixture("edit-plan.json"), join(dir, "edit-plan.json"));
  await copyFile(fixture("voice.json"), join(build, "voice.json"));

  const voice = VoiceManifest.parse(JSON.parse(await readFile(fixture("voice.json"), "utf8")));
  for (const clip of [...Object.values(voice.lines), ...Object.values(voice.sfx)]) {
    const file = join(build, clip.file);
    await mkdir(dirname(file), { recursive: true });
    await run("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${clip.duration}`,
      "-c:a", "libmp3lame", file,
    ]);
  }

  const stage = (name: string, ...args: string[]) =>
    run(TSX, [join(ROOT, "src/cli", `${name}.ts`), dir, ...args]);
  await stage("probe");
  await stage("timeline");
  await stage("compose");
  await stage("render", "--draft");
  await stage("mux");

  const timeline = Timeline.parse(JSON.parse(await readFile(join(build, "timeline.json"), "utf8")));
  const final = join(dir, "out/final.mp4");
  const duration = Number(await probe(final, ["-show_entries", "format=duration", "-of", "csv=p=0"]));
  assert.ok(Math.abs(duration - timeline.total) <= 0.1, `duration ${duration} vs ${timeline.total}`);
  assert.equal(
    await probe(final, ["-select_streams", "v", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0"]),
    "h264,1920,1080",
  );
  assert.equal(
    await probe(final, ["-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]),
    "aac",
  );

  const srt = await readFile(join(dir, "out/final.srt"), "utf8");
  assert.equal(srt.trim().split(/\n\n+/).length, timeline.captions.length);
  assert.ok((await readFile(join(dir, "out/final.vtt"), "utf8")).startsWith("WEBVTT"));

  for (const at of [1.5, 7.5, 17]) {
    const luma = await meanLuma(final, at);
    assert.ok(luma > 16, `frame at ${at}s is too dark (mean luma ${luma})`);
  }
});
