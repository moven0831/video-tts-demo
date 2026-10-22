import assert from "node:assert/strict";
import { test } from "node:test";
import { contactLayout } from "./contact.ts";
import { Timeline } from "../timeline/types.ts";
import {
  assertAudible,
  audioClipCount,
  isMeasurable,
  isSilent,
  measuredFilter,
  parseLoudnorm,
} from "./mux.ts";
import { checkStreams, lintProblems, renderArgs } from "./render.ts";

const STDERR = `Input #0, mov,mp4
[Parsed_loudnorm_0 @ 0x1234]
{
	"input_i" : "-23.54",
	"input_tp" : "-6.12",
	"input_lra" : "4.20",
	"input_thresh" : "-34.10",
	"output_i" : "-14.50",
	"output_tp" : "-1.50",
	"output_lra" : "3.10",
	"output_thresh" : "-24.90",
	"normalization_type" : "dynamic",
	"target_offset" : "0.50"
}
`;

test("parseLoudnorm reads the JSON block at the end of stderr", () => {
  assert.deepEqual(parseLoudnorm(STDERR), {
    input_i: "-23.54",
    input_tp: "-6.12",
    input_lra: "4.20",
    input_thresh: "-34.10",
    target_offset: "0.50",
  });
});

test("parseLoudnorm rejects output without measurements", () => {
  assert.throws(() => parseLoudnorm("no json here"), /no measurements/);
  assert.throws(() => parseLoudnorm('{ "input_i": "-20" }'), /missing input_tp/);
});

test("measuredFilter targets -14 LUFS linearly", () => {
  const filter = measuredFilter(parseLoudnorm(STDERR));
  assert.equal(
    filter,
    "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-23.54:measured_TP=-6.12:measured_LRA=4.20" +
      ":measured_thresh=-34.10:offset=0.50:linear=true",
  );
});

test("parseLoudnorm names the block when it is not JSON", () => {
  assert.throws(
    () => parseLoudnorm("log\n{ \"input_i\" : -23.54, oops }\n"),
    /measurements that are not JSON: \{ "input_i" : -23.54, oops \}/,
  );
});

test("silent audio is not measurable", () => {
  const m = parseLoudnorm(STDERR.replace("-23.54", "-inf"));
  assert.equal(isMeasurable(m), false);
  assert.equal(isSilent(m), true);
  assert.equal(isMeasurable(parseLoudnorm(STDERR)), true);
  assert.equal(isSilent(parseLoudnorm(STDERR)), false);
});

test("a finite integrated loudness with -inf elsewhere is unmeasurable but not silent", () => {
  for (const field of ["-6.12", "4.20", "-34.10", "0.50"]) {
    const m = parseLoudnorm(STDERR.replace(`"${field}"`, '"-inf"'));
    assert.equal(isSilent(m), false, field);
    assert.equal(isMeasurable(m), false, field);
  }
});

test("silence fails the mux when the timeline has audio and passes when it has none", () => {
  const silent = parseLoudnorm(STDERR.replace("-23.54", "-inf"));
  assert.throws(
    () => assertAudible(silent, 3),
    /render produced a silent audio track although the timeline has 3 audio clips/,
  );
  assertAudible(silent, 0);
  assertAudible(parseLoudnorm(STDERR), 3);
});

test("audioClipCount counts narration, sfx and the music bed", () => {
  const timeline = Timeline.parse({
    total: 5,
    stage: { width: 1920, height: 1080 },
    fit: { scale: 1, x: 0, y: 0 },
    segments: [],
    camera: [],
    clicks: [],
    callouts: [],
    cards: [],
    transitions: [],
    narration: [
      { lineId: "a", file: "a.mp3", start: 0, duration: 1 },
      { lineId: "b", file: "b.mp3", start: 1, duration: 1 },
    ],
    captions: [],
    sfx: [{ id: "s", file: "s.mp3", start: 0, duration: 1 }],
  });
  assert.equal(audioClipCount(timeline), 3);
  assert.equal(audioClipCount({ ...timeline, music: { file: "m.mp3", gainDb: -18, lane: [] } }), 4);
  assert.equal(audioClipCount({ ...timeline, narration: [], sfx: [] }), 0);
});

test("checkStreams needs a video stream, and an audio one when the timeline has audio", () => {
  checkStreams("video\naudio\n", 2, "r.mp4");
  checkStreams("video\n", 0, "r.mp4");
  assert.throws(() => checkStreams("audio\n", 0, "r.mp4"), /render produced no video stream: r.mp4/);
  assert.throws(() => checkStreams("video\n", 2, "r.mp4"), /render produced no audio stream/);
});

test("lintProblems reports output that is not JSON", () => {
  assert.throws(
    () => lintProblems(`Error: boom ${"x".repeat(300)}`),
    (err: Error) => {
      assert.match(err.message, /^hyperframes lint printed non-JSON: Error: boom x+$/);
      assert.equal(err.message.length, "hyperframes lint printed non-JSON: ".length + 200);
      return true;
    },
  );
});

test("lintProblems passes a clean report and lists errors and warnings", () => {
  const clean = { ok: true, errorCount: 0, warningCount: 0, findings: [] };
  assert.deepEqual(lintProblems(JSON.stringify(clean)), []);
  const warned = {
    ok: true,
    errorCount: 0,
    warningCount: 1,
    findings: [{ code: "w1", severity: "warning", message: "careful" }],
  };
  assert.deepEqual(lintProblems(JSON.stringify(warned)), ["warning w1: careful"]);
  const failed = { ok: false, errorCount: 1, warningCount: 0, findings: [] };
  assert.deepEqual(lintProblems(JSON.stringify(failed)), ["lint reported ok: false"]);
});

test("renderArgs picks quality and keeps the strict single-worker flags", () => {
  const args = renderArgs("hf", "out.mp4", true);
  assert.equal(args[args.indexOf("--quality") + 1], "draft");
  assert.equal(renderArgs("hf", "out.mp4", false)[args.indexOf("--quality") + 1], "looks");
  assert.ok(args.includes("--strict"));
  assert.equal(args[args.indexOf("--workers") + 1], "1");
});

test("contactLayout gives long videos a 5 s interval and short ones several tiles", () => {
  assert.deepEqual(contactLayout(120), { interval: 5, cols: 6, rows: 4 });
  assert.deepEqual(contactLayout(600), { interval: 20, cols: 6, rows: 5 });
  const short = contactLayout(18.6);
  assert.equal(short.rows, 1);
  assert.ok(short.interval < 5);
});
