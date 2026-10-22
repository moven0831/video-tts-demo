import assert from "node:assert/strict";
import { test } from "node:test";
import { lastShownFrame, OUTPUT_FPS } from "./grid.ts";

test("a video part ending on the output grid shows its last whole frame", () => {
  assert.equal(lastShownFrame(0, 2, 1), 59);
  assert.equal(lastShownFrame(6, 8, 1), 59);
});

test("a start between grid points shifts the frame the last output frame reads", () => {
  assert.equal(lastShownFrame(6.05, 8.05, 1), 59);
  assert.equal(lastShownFrame(6.02, 7.02, 1), 29);
});

test("the source frame index follows the rate", () => {
  assert.equal(lastShownFrame(0, 4, 0.5), 59);
  assert.equal(lastShownFrame(0, 2, 2), 118);
});

test("times are read at the millisecond precision compose writes them", () => {
  assert.equal(lastShownFrame(1.0004, 3.0004, 1), lastShownFrame(1, 3, 1));
});

test("a video part shorter than one output frame still names frame 0", () => {
  assert.equal(lastShownFrame(0.02, 0.03, 1), 0);
  assert.equal(OUTPUT_FPS, 30);
});
