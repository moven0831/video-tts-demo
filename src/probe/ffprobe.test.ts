import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProbe, type ProbeJson } from "./ffprobe.ts";

const sample: ProbeJson = {
  streams: [
    { codec_type: "audio" },
    {
      codec_type: "video",
      width: 1920,
      height: 1080,
      r_frame_rate: "30/1",
      avg_frame_rate: "30000/1001",
      color_space: "bt709",
    },
  ],
  format: { duration: "8.000000" },
};

test("reads the first video stream and format duration", () => {
  assert.deepEqual(parseProbe(sample), {
    width: 1920,
    height: 1080,
    fps: 30000 / 1001,
    duration: 8,
    colorSpace: "bt709",
  });
});

test("falls back to r_frame_rate when avg_frame_rate is 0/0", () => {
  const json = {
    ...sample,
    streams: [
      { codec_type: "video", width: 10, height: 10, avg_frame_rate: "0/0", r_frame_rate: "25/1" },
    ],
  };
  assert.deepEqual(parseProbe(json), { width: 10, height: 10, fps: 25, duration: 8 });
});

test("omits an unknown color space", () => {
  const json = {
    ...sample,
    streams: [
      { codec_type: "video", width: 10, height: 10, avg_frame_rate: "30/1", color_space: "unknown" },
    ],
  };
  assert.equal("colorSpace" in parseProbe(json), false);
});

const video = (extra: Record<string, string>): ProbeJson => ({
  streams: [{ codec_type: "video", width: 10, height: 10, avg_frame_rate: "30/1", ...extra }],
  format: { duration: "8" },
});

test("records the video stream's frame count from nb_frames", () => {
  assert.equal(parseProbe(video({ nb_frames: "240", duration: "9" })).frames, 240);
});

test("derives the frame count from the stream duration when nb_frames is absent", () => {
  assert.equal(parseProbe(video({ duration: "7.99" })).frames, 239);
  assert.equal("frames" in parseProbe(video({})), false);
});

test("flags variable frame rate when r_frame_rate and avg_frame_rate differ by over 1%", () => {
  assert.equal(parseProbe(video({ r_frame_rate: "60/1" })).vfr, true);
  assert.equal("vfr" in parseProbe(video({ r_frame_rate: "30/1" })), false);
  assert.equal("vfr" in parseProbe(video({ r_frame_rate: "30000/1001" })), false);
});

test("rejects input without a video stream", () => {
  assert.throws(() => parseProbe({ streams: [{ codec_type: "audio" }], format: {} }), /no video/);
});
