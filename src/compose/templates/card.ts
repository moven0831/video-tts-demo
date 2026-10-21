import type { Timeline } from "../../timeline/types.ts";
import { esc, num } from "./esc.ts";

export type Card = Timeline["cards"][number];

type CardContext = { index: number; project: string; width: number; height: number };

const PAD = 144;
const ENTER_SEC = 0.6;
const EXIT_SEC = 0.25;

const COMMON_CSS = `
.card { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: var(--bg); color: var(--fg); font-family: var(--font); }
.card .kicker { position: absolute; left: ${PAD}px; top: 112px; font-size: 26px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); }
.card .kicker::before { content: ""; display: inline-block; width: 44px; height: 6px; margin-right: 22px; vertical-align: middle; background: var(--accent); border-radius: 3px; }
.card .t { font-weight: 800; letter-spacing: -0.045em; line-height: 1.02; }
.card .s { font-weight: 500; letter-spacing: -0.01em; color: var(--muted); }
.card .rule { position: absolute; left: ${PAD}px; right: ${PAD}px; bottom: 200px; height: 2px; background: var(--hairline); }
.card .rule i { position: absolute; left: 0; top: 0; width: 240px; height: 2px; background: var(--accent); }
.card .foot { position: absolute; right: ${PAD}px; top: 108px; font-size: 26px; font-weight: 500; color: var(--muted); letter-spacing: 0.02em; }
`;

const KIND_CSS: Record<Card["kind"], string> = {
  title: `
.card .body { position: absolute; left: ${PAD}px; right: ${PAD}px; bottom: 280px; }
.card .t { font-size: 156px; max-width: 1500px; }
.card .s { margin-top: 36px; font-size: 52px; max-width: 1300px; }
`,
  chapter: `
.card .num { position: absolute; left: ${PAD - 12}px; top: 150px; font-size: 520px; font-weight: 800; line-height: 0.82; letter-spacing: -0.06em; color: transparent; -webkit-text-stroke: 4px var(--accent); }
.card .body { position: absolute; left: ${PAD}px; right: ${PAD}px; bottom: 280px; }
.card .t { font-size: 112px; max-width: 1400px; }
.card .s { margin-top: 28px; font-size: 44px; max-width: 1200px; }
`,
  outro: `
.card .body { position: absolute; left: ${PAD}px; right: ${PAD}px; top: 0; bottom: 200px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; }
.card .t { font-size: 136px; max-width: 1400px; }
.card .cta { display: inline-flex; align-items: center; gap: 22px; margin-top: 56px; padding: 24px 44px 24px 48px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 42px; font-weight: 600; letter-spacing: -0.01em; }
.card .cta svg { width: 40px; height: 40px; }
`,
};

const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>`;

function bodyHtml(card: Card, ctx: CardContext): string {
  const title = `<h1 class="t">${esc(card.title)}</h1>`;
  const sub = card.subtitle ? `<p class="s">${esc(card.subtitle)}</p>` : "";
  if (card.kind === "outro") {
    const cta = card.subtitle ? `<div class="cta"><span>${esc(card.subtitle)}</span>${ARROW}</div>` : "";
    return `<div class="body">${title}${cta}</div>`;
  }
  const numeral =
    card.kind === "chapter" ? `<div class="num">${String(ctx.index + 1).padStart(2, "0")}</div>` : "";
  return `${numeral}<div class="body">${title}${sub}</div>`;
}

export function cardFile(card: Card, ctx: CardContext): string {
  const kicker = { title: ctx.project, chapter: "Chapter", outro: "Next" }[card.kind];
  return `<template id="card-${esc(card.id)}-template">
  <div data-composition-id="${esc(card.id)}" data-width="${ctx.width}" data-height="${ctx.height}" style="position:relative;width:${ctx.width}px;height:${ctx.height}px">
    <style>${COMMON_CSS}${KIND_CSS[card.kind]}</style>
    <div class="card">
      <div class="kicker">${esc(kicker)}</div>
      ${bodyHtml(card, ctx)}
      <div class="rule"><i></i></div>
      ${card.kind === "title" ? "" : `<div class="foot">${esc(ctx.project)}</div>`}
    </div>
  </div>
</template>
`;
}

// Motion lives on the root timeline; card files stay static (data-no-timeline on the host).
export function cardMotion(card: Card): string[] {
  const host = `#card-${card.id}`;
  const parts = [".kicker", ".num", ".t", ".s", ".cta", ".rule i", ".foot"].map((s) => `${host} ${s}`);
  const enter = num(card.start);
  const exit = num(Math.max(card.start + ENTER_SEC, card.start + card.duration - EXIT_SEC));
  const sel = JSON.stringify(parts.join(", "));
  return [
    `tl.fromTo(${sel}, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: ${ENTER_SEC}, ease: "power3.out", stagger: 0.08 }, ${enter});`,
    `tl.to(${sel}, { opacity: 0, duration: ${EXIT_SEC}, ease: "power1.in" }, ${exit});`,
  ];
}
