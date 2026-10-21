import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCamera,
  cameraTransform,
  containFit,
  expandBox,
  pointToStage,
  type CameraContext,
} from "./camera.ts";

const stage = { width: 1920, height: 1080 };
const source = { width: 1280, height: 720 };
const fit = containFit(source, stage);

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

function rect(actual: Record<string, number>, expected: Record<string, number>) {
  for (const key of Object.keys(expected)) near(actual[key], expected[key]);
}

test("1280x720 fills the stage at scale 1.5", () => {
  assert.deepEqual(fit, { scale: 1.5, x: 0, y: 0 });
});

test("a 4:3 source is letterboxed left and right", () => {
  assert.deepEqual(containFit({ width: 1024, height: 768 }, stage), {
    scale: 1.40625,
    x: 240,
    y: 0,
  });
});

test("a wide source is letterboxed top and bottom", () => {
  const wide = containFit({ width: 2000, height: 500 }, stage);
  near(wide.scale, 0.96);
  near(wide.x, 0);
  near(wide.y, 300);
});

test("points map through the fit offset", () => {
  assert.deepEqual(pointToStage(fit, 640, 360), { x: 960, y: 540 });
  assert.deepEqual(pointToStage(containFit({ width: 1024, height: 768 }, stage), 0, 0), {
    x: 240,
    y: 0,
  });
});

test("a small box grows to 10% of the frame at 16:9", () => {
  rect(expandBox({ x: 100, y: 100, w: 20, h: 20 }, source), { x: 46, y: 74, w: 128, h: 72 });
});

test("a wide box grows in height, a tall box grows in width", () => {
  rect(expandBox({ x: 400, y: 300, w: 400, h: 100 }, source), { x: 400, y: 237.5, w: 400, h: 225 });
  rect(expandBox({ x: 600, y: 100, w: 100, h: 300 }, source), {
    x: 650 - 800 / 3,
    y: 100,
    w: 1600 / 3,
    h: 300,
  });
});

test("an expanded box is clamped inside the frame", () => {
  rect(expandBox({ x: 0, y: 0, w: 20, h: 20 }, source), { x: 0, y: 0, w: 128, h: 72 });
  rect(expandBox({ x: 1260, y: 700, w: 20, h: 20 }, source), { x: 1152, y: 648, w: 128, h: 72 });
});

test("a box larger than the frame shrinks to the frame at 16:9", () => {
  const square = { width: 1000, height: 1000 };
  rect(expandBox({ x: 0, y: 0, w: 1000, h: 1000 }, square), { x: 0, y: 218.75, w: 1000, h: 562.5 });
});

test("the transform centres the box and caps scale at maxZoom", () => {
  const t = cameraTransform({ x: 640, y: 180, w: 480, h: 270 }, fit, stage, source, 2.4);
  near(t.scale, 2.4);
  near(t.x, -2208);
  near(t.y, -594);
});

test("scale follows the box when under maxZoom", () => {
  const t = cameraTransform({ x: 320, y: 180, w: 640, h: 360 }, fit, stage, source, 2.4);
  near(t.scale, 2);
  near(t.x, 960 - 960 * 2);
  near(t.y, 540 - 540 * 2);
});

test("maxZoom limits a tiny box", () => {
  const t = cameraTransform({ x: 600, y: 340, w: 10, h: 10 }, fit, stage, source, 2);
  near(t.scale, 2);
});

test("translation is clamped so the video still covers the stage", () => {
  const t = cameraTransform({ x: 1260, y: 700, w: 20, h: 20 }, fit, stage, source, 2.4);
  near(t.scale, 2.4);
  near(t.x, 1920 - 1920 * 2.4);
  near(t.y, 1080 - 1080 * 2.4);
});

test("a letterboxed source stays centred horizontally when zoomed", () => {
  const four3 = { width: 1024, height: 768 };
  const f = containFit(four3, stage);
  const t = cameraTransform({ x: 400, y: 300, w: 100, h: 100 }, f, stage, four3, 1.2);
  near(t.scale, 1.2);
  near(t.x, (1920 - (240 + 1440) * 1.2 + -240 * 1.2) / 2);
});

test("a null box returns to the full frame", () => {
  assert.deepEqual(cameraTransform(null, fit, stage, source, 2.4), { scale: 1, x: 0, y: 0 });
});

const ctx: CameraContext = { source, stage, fit, maxZoom: 2.4, moveSec: 0.7 };
const box = { x: 640, y: 180, w: 480, h: 270 };

test("keyframes keep their times when moves do not overlap", () => {
  const keys = buildCamera(
    [
      { t: 1, box },
      { t: 3, box: null },
    ],
    ctx,
  );
  assert.deepEqual(
    keys.map((k) => [k.t, k.duration, k.ease]),
    [
      [1, 0.7, "power2.inOut"],
      [3, 0.7, "power2.inOut"],
    ],
  );
});

test("a move that would overlap the previous one starts when it ends", () => {
  const keys = buildCamera(
    [
      { t: 1, box },
      { t: 1.3, box: null },
      { t: 1.5, box },
    ],
    ctx,
  );
  assert.deepEqual(
    keys.map((k) => k.t),
    [1, 1.7, 2.4],
  );
});
