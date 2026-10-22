import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { VoiceManifest } from "../src/schema/artifacts.ts";
import { Timeline } from "../src/timeline/types.ts";
import { capture, run } from "../src/util/exec.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules/.bin/tsx");
const HF = join(ROOT, "node_modules/.bin/hyperframes");
const fixture = (name: string) => join(ROOT, "test/fixtures", name);

// The centre of the 1920x1080 stage: clear of the chapter pill, the captions and the card chrome.
const REGION = "crop=1100:650:400:150";
// A frame that really shows the source scores near 24 dB against it; another moment scores ~15.
const MIN_PSNR = 20;

async function skipReason(): Promise<string | false> {
  if (process.env.REQUIRE_SMOKE) return false;
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

// The frame at output index n of a video, scaled to the stage when `stage` is set.
async function frameAt(video: string, n: number, to: string, stage = false): Promise<string> {
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", video,
    "-vf", `select=eq(n\\,${n})${stage ? ",scale=1920:1080" : ""}`,
    "-frames:v", "1", to,
  ]);
  return to;
}

async function psnr(a: string, b: string): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info", "-i", a, "-i", b,
    "-lavfi", `[0]${REGION}[x];[1]${REGION}[y];[x][y]psnr`, "-f", "null", "-",
  ]);
  const match = stderr.match(/average:([\d.]+)/);
  assert.ok(match, `no PSNR between ${a} and ${b}`);
  return Number(match[1]);
}

async function meanLuma(image: string): Promise<number> {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-i", image, "-vf", `${REGION},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
    "-f", "null", "-",
  ]);
  const match = stdout.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  assert.ok(match, `no luma reading for ${image}`);
  return Number(match[1]);
}

async function loudness(video: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-nostats", "-i", video, "-af", "ebur128", "-f", "null", "-"]);
  const readings = [...stderr.matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)];
  assert.ok(readings.length > 0, "no integrated loudness reading");
  return Number(readings[readings.length - 1][1]);
}

async function meanVolume(video: string, start: number, duration: number): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-nostats", "-ss", String(start), "-t", String(duration), "-i", video,
    "-af", "volumedetect", "-vn", "-f", "null", "-",
  ]);
  const match = stderr.match(/mean_volume: (-?[\d.]+) dB/);
  assert.ok(match, "no mean volume reading");
  return Number(match[1]);
}

// A testsrc2 recording (it draws a frame counter) with the fixture plan and sine tones as voice.
async function project(t: TestContext, fps: number, simplify: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const build = join(dir, "build");
  await mkdir(build, { recursive: true });

  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=${fps}:duration=8`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "input.mp4"),
  ]);
  const plan = JSON.parse(await readFile(fixture("edit-plan.json"), "utf8"));
  const voice = VoiceManifest.parse(JSON.parse(await readFile(fixture("voice.json"), "utf8")));
  if (simplify) {
    // No camera moves, clicks or sfx: the frames are the bare source.
    for (const chapter of plan.chapters) {
      for (const scene of chapter.scenes) Object.assign(scene, { camera: [], clicks: [], callouts: [] });
    }
    plan.audio.sfx = [];
    voice.sfx = {};
  }
  await writeFile(join(dir, "edit-plan.json"), JSON.stringify(plan));
  await writeFile(join(build, "voice.json"), JSON.stringify(voice));
  for (const clip of [...Object.values(voice.lines), ...Object.values(voice.sfx)]) {
    const file = join(build, clip.file);
    await mkdir(dirname(file), { recursive: true });
    await run("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${clip.duration}`,
      "-c:a", "libmp3lame", file,
    ]);
  }
  const stage = async (name: string, ...args: string[]) => {
    const result = await capture(TSX, [join(ROOT, "src/cli", `${name}.ts`), dir, ...args]);
    assert.equal(result.code, 0, `${name} failed:\n${result.stderr}`);
  };
  const timeline = async () =>
    Timeline.parse(JSON.parse(await readFile(join(build, "timeline.json"), "utf8")));
  return { dir, build, stage, timeline };
}

const reason = await skipReason();

test("probe, timeline, compose, render and mux produce a finished video", { skip: reason, timeout: 240_000 }, async (t) => {
  const { dir, build, stage, timeline: readTimeline } = await project(t, 30, false);
  for (const name of ["probe", "timeline", "compose"]) await stage(name);
  await stage("render", "--draft");
  await stage("mux");

  const timeline = await readTimeline();
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

  // Video: mid-scene frames at an identity camera show the source frame HyperFrames extracts, the
  // freeze shows the last video frame, and the dark card background alone cannot pass either.
  const source = join(dir, "input.mp4");
  const scene = timeline.segments.find((s) => s.scene === "click-through");
  const frozen = timeline.segments.find((s) => s.scene === "open-app");
  const freeze = frozen?.freeze;
  assert.ok(scene && frozen && freeze, "the fixture has a scene and a frozen scene");
  assert.ok(
    timeline.camera.every((k) => k.t + k.duration <= freeze.start + 1e-6),
    "the camera is back at rest before the sampled frames",
  );
  const mid = Math.round(((scene.start + scene.end) / 2) * 30);
  const extracted = Math.floor(((mid / 30 - scene.start) * scene.rate) * 30 + 1e-9);
  const checks = [
    { n: mid, source: Math.round(scene.in * 30) + extracted, what: "mid-scene" },
    {
      n: Math.round(((freeze.start + frozen.end) / 2) * 30),
      source: Math.round(freeze.at * 30),
      what: "freeze",
    },
  ];
  for (const check of checks) {
    const shown = await frameAt(final, check.n, join(build, `shown-${check.what}.png`));
    const expected = await frameAt(source, check.source, join(build, `source-${check.what}.png`), true);
    assert.ok((await meanLuma(shown)) > 60, `${check.what} shows no video`);
    const score = await psnr(shown, expected);
    assert.ok(score > MIN_PSNR, `${check.what} frame ${check.n} has PSNR ${score} against source ${check.source}`);
  }

  // Audio: the mix is normalised to -14 LUFS and the narration is audible where it is placed.
  const lufs = await loudness(final);
  assert.ok(Math.abs(lufs + 14) <= 1.5, `integrated loudness ${lufs} LUFS`);
  const narration = timeline.narration[0];
  const volume = await meanVolume(final, narration.start + 0.1, narration.duration - 0.2);
  assert.ok(volume > -40, `mean volume ${volume} dB during "${narration.lineId}"`);
});

test("at 60 fps the freeze continues the last frame the video showed", { skip: reason, timeout: 240_000 }, async (t) => {
  const { build, stage, timeline: readTimeline } = await project(t, 60, true);
  for (const name of ["probe", "timeline", "compose"]) await stage(name);
  await stage("render", "--draft");

  const frozen = (await readTimeline()).segments.find((s) => s.freeze);
  assert.ok(frozen?.freeze, "the fixture has a frozen scene");
  const last = Math.ceil(frozen.freeze.start * 30 - 1e-3) - 1;
  const render = join(build, "render.mp4");
  const video = await frameAt(render, last, join(build, "last-video.png"));
  const still = await frameAt(render, last + 1, join(build, "first-still.png"));
  const before = await frameAt(render, last - 1, join(build, "before-video.png"));
  // Adjacent distinct source frames score ~17 dB; the same frame scores over 40.
  assert.ok((await psnr(video, still)) > 35, "the first freeze frame differs from the last video frame");
  assert.ok((await psnr(before, video)) < 30, "the sampled frames are not distinguishable");
});
