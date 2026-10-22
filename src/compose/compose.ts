import { basename } from "node:path";
import type { EditPlan } from "../schema/edit-plan.ts";
import type { Timeline } from "../timeline/types.ts";
import { cardFile, cardMotion } from "./templates/card.ts";
import { esc, num } from "./templates/esc.ts";
import { calloutFragment, clickFragment, OVERLAY_CSS, viewAt } from "./templates/overlay.ts";
import { VENDORED } from "./vendor.ts";

export type ComposeResult = {
  files: Record<string, string>;
  copies: { from: string; to: string }[];
  stills: { scene: string; at: number; to: string }[];
  warnings: string[];
};

const FPS = 30;
const FADE_SEC = 0.3;
const EDGE = 0.05;

const THEMES = {
  dark: { bg: "#0b0b10", fg: "#f5f5f7", muted: "rgba(245, 245, 247, 0.62)", hairline: "rgba(245, 245, 247, 0.16)" },
  light: { bg: "#f6f5f2", fg: "#121216", muted: "rgba(18, 18, 22, 0.62)", hairline: "rgba(18, 18, 22, 0.16)" },
};

function themeCss(style: EditPlan["style"]): string {
  const t = THEMES[style.theme];
  const font = style.font.replace(/[^\w -]/g, "");
  return `:root { --bg: ${t.bg}; --fg: ${t.fg}; --muted: ${t.muted}; --hairline: ${t.hairline}; --accent: ${style.accent}; --accent-soft: ${style.accent}33; --accent-glow: ${style.accent}99; --font: "${font}", "Inter", system-ui, sans-serif; }`;
}

const FONT_FACES = [400, 600, 700, 800]
  .map(
    (w) =>
      `@font-face { font-family: "Inter"; font-weight: ${w}; font-style: normal; font-display: block; src: url("assets/fonts/inter-${w}.woff2") format("woff2"); }`,
  )
  .join("\n");

const BASE_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); }
#root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); font-family: var(--font); }
.cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; z-index: 1; }
.cam video, .cam img { position: absolute; }
.card-host { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; z-index: 10; }
.chapter { position: absolute; left: 48px; top: 44px; z-index: 20; display: flex; align-items: center; gap: 14px; padding: 11px 24px 11px 20px; border-radius: 999px; background: rgba(14, 14, 20, 0.8); color: #fff; font-size: 24px; font-weight: 600; letter-spacing: -0.005em; opacity: 0; }
.chapter::before { content: ""; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
.cap { position: absolute; left: 0; right: 0; bottom: 76px; z-index: 25; display: flex; justify-content: center; }
.cap span { max-width: 1500px; padding: 14px 32px; border-radius: 20px; background: rgba(22, 22, 30, 0.9); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 10px 30px rgba(0, 0, 0, 0.35); color: #fff; font-size: 40px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; text-align: center; }
#fade { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; z-index: 30; background: #000; opacity: 0; pointer-events: none; }
`;

type Segment = Timeline["segments"][number];

function segmentHtml(seg: Segment, timeline: Timeline): string {
  const { fit, stage } = timeline;
  // fit centres the video, so its box follows from the stage and the letterbox offsets.
  const box = `left:${num(fit.x)}px;top:${num(fit.y)}px;width:${num(stage.width - 2 * fit.x)}px;height:${num(stage.height - 2 * fit.y)}px`;
  const scene = esc(seg.scene);
  const videoEnd = seg.freeze ? seg.freeze.start : seg.end;
  const rate = seg.rate === 1 ? "" : ` data-playback-rate="${num(seg.rate)}"`;
  const video = `<video id="vid-${scene}" class="clip" src="assets/input.mp4" data-start="${num(seg.start)}" data-duration="${num(videoEnd - seg.start)}" data-media-start="${num(seg.in)}"${rate} style="${box}" muted playsinline></video>`;
  const still = seg.freeze
    ? `<img id="frz-${scene}" class="clip" src="assets/freeze-${scene}.png" data-start="${num(seg.freeze.start)}" data-duration="${num(seg.freeze.duration)}" style="${box}" />`
    : "";
  return video + still;
}

function chapterSpans(timeline: Timeline, plan: EditPlan) {
  return plan.chapters.flatMap((chapter) => {
    const ids = new Set(chapter.scenes.map((s) => s.id));
    const segs = timeline.segments.filter((s) => ids.has(s.scene));
    if (segs.length === 0) return [];
    return [
      {
        id: chapter.id,
        title: chapter.title,
        start: Math.min(...segs.map((s) => s.start)),
        end: Math.max(...segs.map((s) => s.end)),
      },
    ];
  });
}

function transitionJs(timeline: Timeline, warnings: string[]): string[] {
  const js: string[] = [];
  for (const tr of timeline.transitions) {
    if (tr.kind === "cut") continue;
    if (tr.kind === "fade-black") {
      const h = num(Math.min(FADE_SEC, Math.max(tr.duration / 2, 0.1)));
      js.push(
        `tl.to("#fade", { opacity: 1, duration: ${h}, ease: "power1.in" }, ${num(Math.max(0, tr.at - h))});`,
        `tl.to("#fade", { opacity: 0, duration: ${h}, ease: "power1.out" }, ${num(tr.at + tr.duration)});`,
      );
      continue;
    }
    if (tr.kind === "push") warnings.push(`transition "push" at ${tr.at}s falls back to dissolve`);
    const end = tr.at + tr.duration;
    const items = [
      ...timeline.cards.map((c) => ({ sel: `#card-${c.id}`, start: c.start, end: c.start + c.duration })),
      ...timeline.segments.flatMap((s) => [
        { sel: `#vid-${s.scene}`, start: s.start, end: s.freeze ? s.freeze.start : s.end },
        ...(s.freeze ? [{ sel: `#frz-${s.scene}`, start: s.freeze.start, end: s.end }] : []),
      ]),
    ];
    for (const item of items) {
      const sel = JSON.stringify(item.sel);
      if (item.start >= tr.at - EDGE && item.start <= end + EDGE) {
        js.push(
          `tl.fromTo(${sel}, { opacity: 0 }, { opacity: 1, duration: ${num(tr.duration)}, ease: "none" }, ${num(item.start)});`,
        );
      }
      if (item.end >= tr.at - EDGE && item.end <= end + EDGE) {
        js.push(
          `tl.to(${sel}, { opacity: 0, duration: ${num(tr.duration)}, ease: "none" }, ${num(item.end - tr.duration)});`,
        );
      }
    }
  }
  return js;
}

function audioHtml(timeline: Timeline, copies: Map<string, string>): string[] {
  const asset = (file: string) => {
    const to = `assets/audio/${basename(file)}`;
    copies.set(to, file);
    return to;
  };
  const clip = (id: string, file: string, start: number, duration: number, volume: number) =>
    `<audio id="${esc(id)}" src="${esc(asset(file))}" data-start="${num(start)}" data-duration="${num(duration)}" data-volume="${volume}"></audio>`;
  const out = [
    ...timeline.narration.map((n) => clip(`nar-${n.lineId}`, n.file, n.start, n.duration, 1)),
    ...timeline.sfx.map((s) => clip(`sfx-${s.id}`, s.file, s.start, s.duration, 0.8)),
  ];
  const music = timeline.music;
  if (music) {
    const lane = music.lane.length > 0 ? music.lane : [{ t: 0, db: music.gainDb }];
    const points = lane.map((p) => ({ t: num(p.t), v: num(10 ** (p.db / 20)) }));
    const automation = JSON.stringify({ version: 1, lanes: [{ target: "volume", points }] });
    out.push(
      `<audio id="music" src="${esc(asset(music.file))}" data-start="0" data-duration="${num(timeline.total)}" data-fade-out="1.5" data-automation="${esc(automation)}"></audio>`,
    );
  }
  return out;
}

export function compose(timeline: Timeline, plan: EditPlan): ComposeResult {
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  const copies = new Map<string, string>();
  const { stage } = timeline;

  const cardIndex = new Map<string, number>();
  timeline.cards
    .filter((c) => c.kind === "chapter")
    .forEach((c, i) => cardIndex.set(c.id, i));
  const hosts = timeline.cards.map((card) => {
    files[`compositions/cards/${card.id}.html`] = cardFile(card, {
      index: cardIndex.get(card.id) ?? 0,
      project: plan.meta.title,
      width: stage.width,
      height: stage.height,
    });
    return `<div id="card-${esc(card.id)}" class="card-host" data-composition-id="${esc(card.id)}" data-composition-src="compositions/cards/${esc(card.id)}.html" data-start="${num(card.start)}" data-duration="${num(card.duration)}" data-no-timeline></div>`;
  });

  const overlays = [
    ...timeline.clicks.map((c, i) => clickFragment(c, i, viewAt(timeline.camera, c.t))),
    ...timeline.callouts.map((c, i) =>
      calloutFragment(c, i, stage, viewAt(timeline.camera, (c.t0 + c.t1) / 2)),
    ),
  ];
  const spans = chapterSpans(timeline, plan);
  const pills = spans.map(
    (s) =>
      `<div id="chapter-${esc(s.id)}" class="chapter clip" data-start="${num(s.start)}" data-duration="${num(s.end - s.start)}">${esc(s.title)}</div>`,
  );
  const captions =
    plan.style.captions.mode === "burn-in"
      ? timeline.captions.map(
          (c, i) =>
            `<div id="cap-${i}" class="cap clip" data-start="${num(c.start)}" data-duration="${num(c.end - c.start)}"><span>${c.lines.map(esc).join("<br>")}</span></div>`,
        )
      : [];

  const js = [
    `tl.set(".cam", { x: 0, y: 0, scale: 1 }, 0);`,
    ...timeline.camera.map(
      (k) =>
        `tl.to(".cam", { scale: ${num(k.scale)}, x: ${num(k.x)}, y: ${num(k.y)}, duration: ${num(k.duration)}, ease: ${JSON.stringify(k.ease)} }, ${num(k.t)});`,
    ),
    ...overlays.flatMap((o) => o.js),
    ...timeline.cards.flatMap((c) => cardMotion(c)),
    ...spans.flatMap((s) => [
      `tl.fromTo("#chapter-${s.id}", { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: 0.3, ease: "power2.out" }, ${num(s.start)});`,
      `tl.to("#chapter-${s.id}", { opacity: 0, duration: 0.25 }, ${num(Math.max(s.start + 0.3, s.end - 0.25))});`,
    ]),
    ...transitionJs(timeline, warnings),
  ];

  const stills = timeline.segments.flatMap((s) =>
    s.freeze ? [{ scene: s.scene, at: s.freeze.at, to: `assets/freeze-${s.scene}.png` }] : [],
  );

  files["index.html"] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${stage.width}, height=${stage.height}" />
    <script src="assets/gsap.min.js"></script>
    <style>
${FONT_FACES}
${themeCss(plan.style)}
${BASE_CSS}${OVERLAY_CSS}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="demo" data-start="0" data-duration="${num(timeline.total)}" data-width="${stage.width}" data-height="${stage.height}" data-fps="${FPS}">
      <div class="cam" id="cam">
        ${timeline.segments.map((s) => segmentHtml(s, timeline)).join("\n        ")}
        ${overlays.map((o) => o.html).join("\n        ")}
      </div>
      ${hosts.join("\n      ")}
      ${pills.join("\n      ")}
      ${captions.join("\n      ")}
      <div id="fade"></div>
      ${audioHtml(timeline, copies).join("\n      ")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${js.join("\n      ")}
      window.__timelines = window.__timelines || {};
      window.__timelines["demo"] = tl;
    </script>
  </body>
</html>
`;

  return {
    files,
    copies: [
      { from: "../input.mp4", to: "assets/input.mp4" },
      ...VENDORED,
      ...[...copies].map(([to, from]) => ({ from, to })),
    ],
    stills,
    warnings,
  };
}
