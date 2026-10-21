import assert from "node:assert/strict";
import { test } from "node:test";
import { colorMatrix, frameFile, gridLayout, planSheets, tileTimes } from "./frames.ts";

test("short recordings get one tile per second", () => {
  assert.deepEqual(tileTimes(4, 180), [0, 1, 2, 3]);
  assert.equal(tileTimes(180, 180).length, 180);
});

test("long recordings are sampled evenly including both ends", () => {
  const times = tileTimes(600, 180);
  assert.equal(times.length, 180);
  assert.equal(times[0], 0);
  assert.equal(times[179], 599);
  assert.equal(new Set(times).size, 180);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("nine tiles per sheet, geometry in sheet pixels", () => {
  const sheets = planSheets(11, 10.5);
  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets[0].tiles[0], { t: 0, x: 0, y: 0, w: 640, h: 360 });
  assert.deepEqual(sheets[0].tiles[4], { t: 4, x: 640, y: 360, w: 640, h: 360 });
  assert.deepEqual(sheets[0].tiles[8], { t: 8, x: 1280, y: 720, w: 640, h: 360 });
  assert.deepEqual(sheets[1].tiles.map((t) => t.t), [9, 10]);
});

test("manifest entries have exactly file, t0, t1, tiles", () => {
  const [first, second] = planSheets(11, 10.5);
  assert.deepEqual(Object.keys(first), ["file", "t0", "t1", "tiles"]);
  assert.equal(first.file, "sheets/01.jpg");
  assert.equal(second.file, "sheets/02.jpg");
  assert.deepEqual([first.t0, first.t1], [0, 9]);
  assert.deepEqual([second.t0, second.t1], [9, 10.5]);
});

test("a 20 minute recording fits in 20 sheets", () => {
  const sheets = planSheets(1200, 1199.5);
  assert.equal(sheets.length, 20);
  assert.equal(sheets[19].t1, 1199.5);
  assert.equal(sheets[0].t1, sheets[1].t0);
});

test("grid layout places tiles row by row", () => {
  assert.equal(gridLayout(4, 3, 10, 5), "0_0|10_0|20_0|0_5");
});

test("color matrix follows the tagged color space and defaults to bt709", () => {
  assert.equal(colorMatrix(undefined), "bt709");
  assert.equal(colorMatrix("bt709"), "bt709");
  assert.equal(colorMatrix("smpte170m"), "bt601");
  assert.equal(colorMatrix("bt2020nc"), "bt2020");
});

test("frame files are numbered from 0001 at second 0", () => {
  assert.equal(frameFile(0), "0001.jpg");
  assert.equal(frameFile(41), "0042.jpg");
});
