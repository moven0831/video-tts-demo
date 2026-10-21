import type { Box } from "../schema/edit-plan.ts";
import type { Timeline } from "./types.ts";

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };
type Fit = Timeline["fit"];
type Transform = { scale: number; x: number; y: number };

const MIN_BOX_FRACTION = 0.1;
const ASPECT = 16 / 9;
const EASE = "power2.inOut";

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function containFit(source: Size, stage: Size): Fit {
  const scale = Math.min(stage.width / source.width, stage.height / source.height);
  return {
    scale,
    x: (stage.width - source.width * scale) / 2,
    y: (stage.height - source.height * scale) / 2,
  };
}

export function pointToStage(fit: Fit, x: number, y: number): { x: number; y: number } {
  return { x: x * fit.scale + fit.x, y: y * fit.scale + fit.y };
}

export function boxToStage(fit: Fit, box: Rect): Rect {
  const { x, y } = pointToStage(fit, box.x, box.y);
  return { x, y, w: box.w * fit.scale, h: box.h * fit.scale };
}

export function expandBox(box: Rect, frame: Size): Rect {
  let w = Math.max(box.w, frame.width * MIN_BOX_FRACTION);
  let h = Math.max(box.h, frame.height * MIN_BOX_FRACTION);
  if (w / h < ASPECT) w = h * ASPECT;
  else h = w / ASPECT;
  const shrink = Math.min(1, frame.width / w, frame.height / h);
  w *= shrink;
  h *= shrink;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    x: clamp(cx - w / 2, 0, frame.width - w),
    y: clamp(cy - h / 2, 0, frame.height - h),
    w,
    h,
  };
}

// Keeps the scaled video covering the stage. On a letterboxed axis the video is smaller than the
// stage, so the range is empty and the video stays centred instead.
function coverClamp(t: number, stageLen: number, offset: number, videoLen: number, scale: number) {
  const lo = stageLen - (offset + videoLen) * scale;
  const hi = -offset * scale;
  return lo <= hi ? clamp(t, lo, hi) : (lo + hi) / 2;
}

export function cameraTransform(
  box: Box | null,
  fit: Fit,
  stage: Size,
  source: Size,
  maxZoom: number,
): Transform {
  if (box === null) return { scale: 1, x: 0, y: 0 };
  const target = boxToStage(fit, expandBox(box, source));
  const scale = clamp(Math.min(stage.width / target.w, stage.height / target.h), 1, maxZoom);
  const x = stage.width / 2 - (target.x + target.w / 2) * scale;
  const y = stage.height / 2 - (target.y + target.h / 2) * scale;
  return {
    scale,
    x: coverClamp(x, stage.width, fit.x, source.width * fit.scale, scale),
    y: coverClamp(y, stage.height, fit.y, source.height * fit.scale, scale),
  };
}

export type CameraContext = {
  source: Size;
  stage: Size;
  fit: Fit;
  maxZoom: number;
  moveSec: number;
};

// Keys carry output times in play order; a move never starts before the previous one ends.
export function buildCamera(
  keys: { t: number; box: Box | null }[],
  ctx: CameraContext,
): Timeline["camera"] {
  let free = 0;
  return keys.map((key) => {
    const t = Math.max(key.t, free);
    free = t + ctx.moveSec;
    const transform = cameraTransform(key.box, ctx.fit, ctx.stage, ctx.source, ctx.maxZoom);
    return { t, ...transform, duration: ctx.moveSec, ease: EASE };
  });
}
