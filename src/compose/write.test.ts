import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { run } from "../util/exec.ts";
import { ffmpegSkip } from "../util/skip.ts";
import { parseStreamTraits, place, samplingFilters, stillIndex, writeStill } from "./write.ts";

const skip = ffmpegSkip();

test("the still index counts output frames from the media start", () => {
  for (const index of [0, 1, 59, 1439]) {
    assert.equal(stillIndex(4 + index / 30, 4), index);
  }
  assert.equal(stillIndex(0.001 + 12 / 30, 0.001), 12);
});

test("sampling filters follow HyperFrames: grid snap for constant rates, none for VFR", () => {
  const cfr = samplingFilters(4.5, 0, false);
  assert.deepEqual(cfr, [
    "settb=AVTB",
    "setpts=if(isnan(FR)\\,PTS\\,(0+round((PTS*TB+4.5-0)*FR)/FR-4.5)/TB)",
    "settb=intb/2",
    "setpts=PTS-lte(TB\\,0.001)",
    "fps=30:start_time=0:round=up",
  ]);
  assert.deepEqual(samplingFilters(4.5, 0, true), cfr.slice(2));
  assert.match(samplingFilters(1, 0.25, false)[1], /\(0\.25\+round\(\(PTS\*TB\+1-0\.25\)\*FR\)/);
});

test("stream traits read the video lead and a diverging frame rate", () => {
  const video = { codec_type: "video", start_time: "0.100000", r_frame_rate: "30/1", avg_frame_rate: "30/1" };
  const audio = { codec_type: "audio", start_time: "0.000000" };
  assert.deepEqual(parseStreamTraits({ streams: [video] }), { lead: 0, vfr: false });
  assert.deepEqual(parseStreamTraits({ streams: [video, audio] }), { lead: 0.1, vfr: false });
  const cover = { codec_type: "video", start_time: "-5", disposition: { attached_pic: 1 } };
  assert.equal(parseStreamTraits({ streams: [video, cover] }).lead, 0);
  const near = { ...video, avg_frame_rate: "2800/100" };
  assert.equal(parseStreamTraits({ streams: [near] }).vfr, false);
  const far = { ...video, avg_frame_rate: "20/1" };
  assert.equal(parseStreamTraits({ streams: [far] }).vfr, true);
});

async function frames(t: TestContext, ...args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "still-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "in.mp4");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", ...args, "-pix_fmt", "yuv420p", input]);
  return { dir, input };
}

test("a still past the end of the video throws, naming the scene and time", { skip }, async (t) => {
  const { dir, input } = await frames(t, "-i", "testsrc2=s=64x64:d=1:r=10");
  const base = { mediaStart: 0, matrix: "bt709", lead: 0, vfr: false };

  const png = join(dir, "ok.png");
  await writeStill(input, png, { ...base, index: 5 }, { scene: "open", at: 0.5 });
  assert.ok((await stat(png)).size > 0);

  await assert.rejects(
    writeStill(input, join(dir, "late.png"), { ...base, index: 500 }, { scene: "open", at: 50 }),
    /freeze frame for scene "open" at 50 s/,
  );
});

test("the still is the frame HyperFrames' extraction yields at that index, at 60 fps", { skip }, async (t) => {
  const { dir, input } = await frames(t, "-i", "testsrc2=s=128x72:d=4:r=60");
  const mediaStart = 1;
  const options = { mediaStart, matrix: "bt709", lead: 0, vfr: false };
  const all = join(dir, "all");
  await mkdir(all);
  await run("ffmpeg", [
    ...["-v", "error", "-noaccurate_seek", "-ss", String(mediaStart), "-i", input],
    ...["-vf", [...samplingFilters(mediaStart, 0, false), "scale=in_color_matrix=bt709:out_color_matrix=bt709"].join(",")],
    ...["-fps_mode", "passthrough", join(all, "f%03d.png")],
  ]);
  assert.ok((await readdir(all)).length >= 89);
  for (const index of [0, 1, 40, 87]) {
    const still = join(dir, `s${index}.png`);
    await writeStill(input, still, { ...options, index }, { scene: "s", at: 0 });
    const expected = join(all, `f${String(index + 1).padStart(3, "0")}.png`);
    assert.deepEqual(await readFile(still), await readFile(expected), `index ${index}`);
  }
});

function failing(code: string) {
  return async () => {
    throw Object.assign(new Error(code), { code });
  };
}

test("place links a file, and copies when linking is not possible", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "place-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const from = join(dir, "a.mp3");
  await writeFile(from, "audio");
  await place(from, join(dir, "out/linked.mp3"));
  assert.equal((await stat(from)).ino, (await stat(join(dir, "out/linked.mp3"))).ino);
  for (const code of ["EXDEV", "EPERM", "ENOTSUP", "EMLINK"]) {
    const to = join(dir, `out/${code}.mp3`);
    await place(from, to, failing(code));
    assert.equal(await readFile(to, "utf8"), "audio");
    assert.notEqual((await stat(from)).ino, (await stat(to)).ino);
  }
});

test("place does not hide other link failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "place-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const from = join(dir, "a.mp3");
  await writeFile(from, "audio");
  await assert.rejects(place(from, join(dir, "out/b.mp3"), failing("EACCES")), /EACCES/);
});

test("place names a missing source and the stage that writes it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "place-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const from = join(dir, "gone.mp3");
  await assert.rejects(
    place(from, join(dir, "out/b.mp3")),
    new RegExp(`${from} is missing; rerun the stage that writes it \\(voice for audio\\)`),
  );
});
