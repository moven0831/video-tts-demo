import type { Motion, Probe } from "../schema/artifacts.ts";
import { runBuffer } from "../util/exec.ts";

export const MOTION_W = 320;
export const MOTION_H = 180;
const LEVEL = 24;
const MIN_CHANGED = 0.002;
const MIN_IDLE_SEC = 2;

export function motionFromFrames(frames: Buffer[], w: number, h: number, probe: Probe): Motion {
  const sx = probe.width / w;
  const sy = probe.height / h;
  const boxes: Motion["boxes"] = frames.map((frame, t) => {
    if (t === 0) return { t, box: null };
    const prev = frames[t - 1];
    let count = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < w * h; i++) {
      if (Math.abs(frame[i] - prev[i]) <= LEVEL) continue;
      const x = i % w;
      const y = (i - x) / w;
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (count < MIN_CHANGED * w * h) return { t, box: null };
    const x = Math.floor(minX * sx);
    const y = Math.floor(minY * sy);
    return {
      t,
      box: {
        x,
        y,
        w: Math.min(Math.ceil((maxX + 1) * sx), probe.width) - x,
        h: Math.min(Math.ceil((maxY + 1) * sy), probe.height) - y,
      },
    };
  });

  // Second 0 has no predecessor, so it never counts toward an idle run.
  const idle: Motion["idle"] = [];
  let start = -1;
  for (let t = 1; t <= boxes.length; t++) {
    const empty = t < boxes.length && boxes[t].box === null;
    if (empty && start < 0) start = t;
    if (!empty && start >= 0) {
      if (t - start >= MIN_IDLE_SEC) idle.push({ t0: start, t1: t });
      start = -1;
    }
  }
  return { boxes, idle };
}

export async function analyseMotion(input: string, probe: Probe): Promise<Motion> {
  const raw = await runBuffer("ffmpeg", [
    ...["-hide_banner", "-v", "error", "-i", input],
    ...["-vf", `fps=1,scale=${MOTION_W}:${MOTION_H}`, "-an"],
    ...["-f", "rawvideo", "-pix_fmt", "gray", "-"],
  ]);
  const size = MOTION_W * MOTION_H;
  const frames: Buffer[] = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  return motionFromFrames(frames, MOTION_W, MOTION_H, probe);
}
