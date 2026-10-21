import assert from "node:assert/strict";
import { test } from "node:test";
import { stillFrame } from "./write.ts";

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
