import assert from "node:assert/strict";
import { test } from "node:test";
import { duckingLane } from "./ducking.ts";

const times = (lane: { t: number }[]) => lane.map((p) => Math.round(p.t * 1e6) / 1e6);

test("lane starts at gain and ramps around one window", () => {
  const lane = duckingLane([{ start: 2, end: 4 }], 10, -18, -12);
  assert.deepEqual(lane, [
    { t: 0, db: -18 },
    { t: 1.7, db: -18 },
    { t: 2, db: -30 },
    { t: 4, db: -30 },
    { t: 4.3, db: -18 },
  ]);
});

test("windows closer than 0.6 s merge, farther ones stay apart", () => {
  const merged = duckingLane(
    [
      { start: 1, end: 2 },
      { start: 2.5, end: 3 },
    ],
    10,
    -18,
    -12,
  );
  assert.deepEqual(times(merged), [0, 0.7, 1, 3, 3.3]);

  const apart = duckingLane(
    [
      { start: 1, end: 2 },
      { start: 2.7, end: 3 },
    ],
    10,
    -18,
    -12,
  );
  assert.deepEqual(times(apart), [0, 0.7, 1, 2, 2.3, 2.4, 2.7, 3, 3.3]);
});

test("points are sorted with no duplicate times", () => {
  const lane = duckingLane(
    [
      { start: 5, end: 6 },
      { start: 0.1, end: 1 },
    ],
    10,
    -18,
    -12,
  );
  const t = times(lane);
  assert.deepEqual(t, [...new Set(t)].sort((a, b) => a - b));
  assert.deepEqual(lane[0], { t: 0, db: -18 });
  assert.equal(t.at(-1), 6.3);
});

test("no windows gives only the explicit start point", () => {
  assert.deepEqual(duckingLane([], 10, -18, -12), [{ t: 0, db: -18 }]);
});
