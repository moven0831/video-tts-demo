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

test("rejects input without a video stream", () => {
  assert.throws(() => parseProbe({ streams: [{ codec_type: "audio" }], format: {} }), /no video/);
});
