import type { Timeline } from "../../timeline/types.ts";
import { esc, num } from "./esc.ts";

type Click = Timeline["clicks"][number];
type Callout = Timeline["callouts"][number];
type Box = Callout["box"];
type Side = "top" | "bottom" | "left" | "right";
type Stage = Timeline["stage"];
type Keyframe = Timeline["camera"][number];

export type Fragment = { html: string; js: string[] };
export type View = { scale: number; x: number; y: number };

const RING_RADIUS = 38;
const GAP = 16;
const ARROW_LEN = 84;
const TWEEN = 0.25;

// Camera state a moment after the move that last started at or before t.
export function viewAt(camera: Keyframe[], t: number): View {
  const last = camera.filter((k) => k.t <= t).at(-1);
  return last ?? { scale: 1, x: 0, y: 0 };
}

// Overlays ride the camera, so strokes and labels are drawn thinner by this factor to keep
// them readable but not heavy when the camera is zoomed in.
function unit(view: View): number {
  return num(1 / view.scale ** 0.7);
}

export function pickSide(box: Box, stage: Stage, view: View = { scale: 1, x: 0, y: 0 }): Side {
  const left = Math.max(0, -view.x / view.scale);
  const top = Math.max(0, -view.y / view.scale);
  const right = Math.min(stage.width, left + stage.width / view.scale);
  const bottom = Math.min(stage.height, top + stage.height / view.scale);
  const room: Record<Side, number> = {
    top: box.y - top,
    bottom: bottom - (box.y + box.h),
    left: box.x - left,
    right: right - (box.x + box.w),
  };
  return (Object.keys(room) as Side[]).reduce((best, side) => (room[side] > room[best] ? side : best));
}

export function clickFragment(click: Click, i: number, view: View): Fragment {
  const u = unit(view);
  const r = RING_RADIUS * u;
  const rings = click.kind === "double" ? [0, 0.18] : [0];
  const html: string[] = [];
  const js: string[] = [];
  rings.forEach((delay, k) => {
    const id = `ring-${i}-${k}`;
    html.push(
      `<div id="${id}" class="ring" style="--u:${u};left:${num(click.x - r)}px;top:${num(click.y - r)}px"></div>`,
    );
    const at = num(click.t + delay);
    js.push(
      `tl.set("#${id}", { opacity: 1, scale: 0.35 }, ${at});`,
      `tl.to("#${id}", { opacity: 0, scale: 1.7, duration: 0.6, ease: "power2.out" }, ${at});`,
    );
  });
  html.push(
    `<div id="dot-${i}" class="dot" style="--u:${u};left:${num(click.x - 9 * u)}px;top:${num(click.y - 9 * u)}px"></div>`,
  );
  js.push(
    `tl.set("#dot-${i}", { opacity: 1, scale: 0.2 }, ${num(click.t)});`,
    `tl.to("#dot-${i}", { scale: 1, duration: 0.15, ease: "back.out(2)" }, ${num(click.t)});`,
    `tl.to("#dot-${i}", { opacity: 0, duration: 0.3 }, ${num(click.t + 0.3)});`,
  );
  return { html: html.join(""), js };
}

function labelWrap(box: Box, side: Side, offset: number, label: string, stage: Stage): string {
  const { x, y, w, h } = box;
  const style = {
    top: `left:${x}px;width:${w}px;bottom:${num(offset + stage.height - y)}px;height:96px;align-items:flex-end;justify-content:center`,
    bottom: `left:${x}px;width:${w}px;top:${num(y + h + offset)}px;height:96px;align-items:flex-start;justify-content:center`,
    left: `top:${y}px;height:${h}px;right:${num(offset + stage.width - x)}px;width:900px;align-items:center;justify-content:flex-end`,
    right: `top:${y}px;height:${h}px;left:${num(x + w + offset)}px;width:900px;align-items:center;justify-content:flex-start`,
  }[side];
  return `<div class="lw" style="${style}"><span class="pill">${esc(label)}</span></div>`;
}

// Deterministic wobble so the same plan always draws the same ellipse.
function scribble(box: Box, u: number): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2 + 34 * u;
  const ry = box.h / 2 + 26 * u;
  const steps = 64;
  const points: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const turn = k / steps;
    const a = -2.1 + turn * Math.PI * 2 * 1.06;
    const wobble = 1 + 0.035 * Math.sin(turn * 11) + turn * 0.05;
    const px = cx + rx * wobble * Math.cos(a);
    const py = cy + ry * wobble * Math.sin(a) + turn * 6 * u;
    points.push(`${k === 0 ? "M" : "L"}${num(px)} ${num(py)}`);
  }
  return points.join(" ");
}

function arrowGeometry(box: Box, side: Side, u: number) {
  const { x, y, w, h } = box;
  const gap = GAP * u;
  const tip = {
    top: { x: x + w / 2, y: y - gap },
    bottom: { x: x + w / 2, y: y + h + gap },
    left: { x: x - gap, y: y + h / 2 },
    right: { x: x + w + gap, y: y + h / 2 },
  }[side];
  const dir = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side];
  const tail = { x: tip.x + dir[0] * ARROW_LEN * u, y: tip.y + dir[1] * ARROW_LEN * u };
  const back = 22 * u;
  const wing = 18 * u;
  const headPath =
    `M${num(tip.x + dir[0] * back + dir[1] * wing)} ${num(tip.y + dir[1] * back + dir[0] * wing)} ` +
    `L${num(tip.x)} ${num(tip.y)} ` +
    `L${num(tip.x + dir[0] * back - dir[1] * wing)} ${num(tip.y + dir[1] * back - dir[0] * wing)}`;
  return { tip, tail, headPath };
}

export function calloutFragment(callout: Callout, i: number, stage: Stage, view: View): Fragment {
  const id = `co-${i}`;
  const u = unit(view);
  const side = callout.side === "auto" ? pickSide(callout.box, stage, view) : callout.side;
  const { x, y, w, h } = callout.box;
  const t0 = num(callout.t0);
  const out = num(Math.max(callout.t0 + TWEEN, callout.t1 - TWEEN));
  const pad = 10 * u;
  const js: string[] = [];
  let body: string;
  if (callout.kind === "box") {
    body =
      `<div class="frame" style="left:${num(x - pad)}px;top:${num(y - pad)}px;width:${num(w + 2 * pad)}px;height:${num(h + 2 * pad)}px"></div>` +
      labelWrap(callout.box, side, (GAP + 10) * u, callout.label, stage);
  } else if (callout.kind === "arrow") {
    const g = arrowGeometry(callout.box, side, u);
    body =
      `<svg class="vec" viewBox="0 0 ${stage.width} ${stage.height}"><path class="shaft" pathLength="1" d="M${num(g.tail.x)} ${num(g.tail.y)} L${num(g.tip.x)} ${num(g.tip.y)}"/><path class="head" d="${g.headPath}"/></svg>` +
      labelWrap(callout.box, side, (GAP + ARROW_LEN) * u, callout.label, stage);
    js.push(
      `tl.fromTo("#${id} .shaft", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: ${TWEEN}, ease: "power2.out" }, ${t0});`,
    );
  } else {
    const away = (side === "top" || side === "bottom" ? 60 : 68) * u;
    body =
      `<svg class="vec" viewBox="0 0 ${stage.width} ${stage.height}"><path class="scrawl" pathLength="1" d="${scribble(callout.box, u)}"/></svg>` +
      labelWrap(callout.box, side, away, callout.label, stage);
    js.push(
      `tl.fromTo("#${id} .scrawl", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.3, ease: "power1.out" }, ${t0});`,
    );
  }
  js.unshift(
    `tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${TWEEN}, ease: "power2.out" }, ${t0});`,
    `tl.to("#${id}", { opacity: 0, duration: ${TWEEN}, ease: "power1.in" }, ${out});`,
  );
  return {
    html: `<div id="${id}" class="co co-${callout.kind}" style="--u:${u}">${body}</div>`,
    js,
  };
}

export const OVERLAY_CSS = `
.co, .ring, .dot { position: absolute; opacity: 0; pointer-events: none; }
.co { left: 0; top: 0; width: 1920px; height: 1080px; }
.ring { width: calc(${RING_RADIUS * 2}px * var(--u)); height: calc(${RING_RADIUS * 2}px * var(--u)); border-radius: 50%; border: calc(5px * var(--u)) solid var(--accent); box-shadow: 0 0 calc(24px * var(--u)) var(--accent-glow); }
.dot { width: calc(18px * var(--u)); height: calc(18px * var(--u)); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 calc(4px * var(--u)) #fff; }
.frame { position: absolute; border: calc(4px * var(--u)) solid var(--accent); border-radius: calc(18px * var(--u)); box-shadow: 0 0 0 calc(8px * var(--u)) var(--accent-soft), 0 0 calc(48px * var(--u)) var(--accent-glow); }
.lw { position: absolute; display: flex; }
.pill { padding: calc(10px * var(--u)) calc(24px * var(--u)); border-radius: 999px; background: var(--accent); color: #fff; font-size: calc(30px * var(--u)); font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; box-shadow: 0 calc(8px * var(--u)) calc(28px * var(--u)) rgba(0, 0, 0, 0.35); }
.vec { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: visible; }
.vec path { fill: none; stroke: var(--accent); stroke-width: calc(7px * var(--u)); stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 calc(8px * var(--u)) var(--accent-glow)); }
.shaft, .scrawl { stroke-dasharray: 1; }
`;
