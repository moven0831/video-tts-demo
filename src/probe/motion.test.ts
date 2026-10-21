import assert from "node:assert/strict";
import { test } from "node:test";
import { motionFromFrames } from "./motion.ts";

const W = 20;
const H = 10;
const probe = { width: 200, height: 100, fps: 30, duration: 6 };

function frame(fill = 0, rect?: { x: number; y: number; w: number; h: number; value: number }) {
  const buf = Buffer.alloc(W * H, fill);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      buf.fill(rect.value, y * W + rect.x, y * W + rect.x + rect.w);
    }
  }
  return buf;
}

test("boxes cover changed pixels, scaled to source pixels", () => {
  const motion = motionFromFrames(
    [frame(), frame(0, { x: 4, y: 2, w: 6, h: 3, value: 200 })],
    W,
    H,
    probe,
  );
  assert.deepEqual(motion.boxes, [
    { t: 0, box: null },
    { t: 1, box: { x: 40, y: 20, w: 60, h: 30 } },
  ]);
});

test("changes under the 24 level are ignored", () => {
  const motion = motionFromFrames([frame(), frame(24)], W, H, probe);
  assert.equal(motion.boxes[1].box, null);
});

test("a change below 0.2% of pixels is ignored", () => {
  const w = 100;
  const h = 100;
  const small = Buffer.alloc(w * h);
  small.fill(255, 0, 19);
  assert.equal(motionFromFrames([Buffer.alloc(w * h), small], w, h, probe).boxes[1].box, null);
  small.fill(255, 0, 20);
  assert.notEqual(motionFromFrames([Buffer.alloc(w * h), small], w, h, probe).boxes[1].box, null);
});

test("idle spans need two consecutive empty seconds", () => {
  const moving = frame(0, { x: 0, y: 0, w: 10, h: 10, value: 255 });
  const frames = [frame(), moving, moving, moving, frame(), frame(), frame(), moving];
  const motion = motionFromFrames(frames, W, H, probe);
  assert.deepEqual(
    motion.boxes.map((b) => b.box !== null),
    [false, true, false, false, true, false, false, true],
  );
  assert.deepEqual(motion.idle, [
    { t0: 2, t1: 4 },
    { t0: 5, t1: 7 },
  ]);
});

test("one empty second is not idle, and a run at the end is closed", () => {
  const moving = frame(0, { x: 0, y: 0, w: 10, h: 10, value: 255 });
  assert.deepEqual(motionFromFrames([frame(), moving, frame(255), frame(255)], W, H, probe).idle, []);
  const still = motionFromFrames([frame(), frame(), frame(), frame()], W, H, probe);
  assert.deepEqual(still.idle, [{ t0: 1, t1: 4 }]);
});
