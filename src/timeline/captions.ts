import type { Word } from "../schema/artifacts.ts";

export type Caption = { start: number; end: number; lines: string[] };

const MAX_CHARS = 42;
const MAX_CPS = 20;
const MIN_HOLD_SEC = 1.8;
const HOLD_TAIL_SEC = 0.6;
const MAX_GAP_SEC = 0.3;
const SENTENCE_END = /[.!?…]["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;
const BREAK_BEFORE = new Set(["and", "but", "or", "so", "with", "to", "for", "in", "on", "of", "from"]);

// Break weight dominates; line balance only separates breaks of the same kind.
const WEIGHT = 6;

const text = (words: Word[]) => words.map((word) => word.text).join(" ");

// The cps limit applies to the time a cue is on screen, not to the speech alone.
const shownSec = (words: Word[]) =>
  Math.max(MIN_HOLD_SEC, words[words.length - 1].end - words[0].start + HOLD_TAIL_SEC);

function breakWeight(prev: Word, next: Word): number {
  if (CLAUSE_END.test(prev.text)) return 3;
  return BREAK_BEFORE.has(next.text.toLowerCase().replace(/[^a-z]/g, "")) ? 2 : 1;
}

function bestSplit(words: Word[], accept: (left: Word[], right: Word[]) => boolean): number | null {
  const total = text(words).length;
  let best: { score: number; at: number } | null = null;
  for (let at = 1; at < words.length; at++) {
    const left = words.slice(0, at);
    const right = words.slice(at);
    if (!accept(left, right)) continue;
    const imbalance = Math.abs(text(left).length - text(right).length) / total;
    const score = breakWeight(words[at - 1], words[at]) * WEIGHT - imbalance * 10;
    if (best === null || score > best.score) best = { score, at };
  }
  return best?.at ?? null;
}

function fitLines(words: Word[]): string[] | null {
  const whole = text(words);
  if (whole.length <= MAX_CHARS) return [whole];
  const at = bestSplit(
    words,
    (left, right) => text(left).length <= MAX_CHARS && text(right).length <= MAX_CHARS,
  );
  return at === null ? null : [text(words.slice(0, at)), text(words.slice(at))];
}

function fits(words: Word[]): boolean {
  if (fitLines(words) === null) return false;
  return text(words).length / shownSec(words) <= MAX_CPS;
}

function splitCue(words: Word[]): Word[][] {
  if (words.length === 1 || fits(words)) return [words];
  const at = bestSplit(words, () => true);
  if (at === null) return [words];
  return [...splitCue(words.slice(0, at)), ...splitCue(words.slice(at))];
}

function chunks(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    const prev = current.at(-1);
    if (prev && word.start - prev.end > MAX_GAP_SEC) {
      out.push(current);
      current = [];
    }
    current.push(word);
    if (SENTENCE_END.test(word.text)) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function buildCaptions(words: Word[]): Caption[] {
  const cues = chunks(words).flatMap(splitCue);
  return cues.map((cue, i) => {
    const start = cue[0].start;
    const next = cues[i + 1]?.[0].start ?? Infinity;
    return {
      start,
      end: Math.min(start + shownSec(cue), next),
      lines: fitLines(cue) ?? [text(cue)],
    };
  });
}

function timestamp(sec: number, separator: "," | "."): string {
  const ms = Math.round(sec * 1000);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms % 1000, 3)}`;
}

export function toSrt(captions: Caption[]): string {
  return captions
    .map((cue, i) => {
      const range = `${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}`;
      return `${i + 1}\n${range}\n${cue.lines.join("\n")}\n`;
    })
    .join("\n");
}

export function toVtt(captions: Caption[]): string {
  const cues = captions.map((cue) => {
    const range = `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}`;
    return `${range}\n${cue.lines.join("\n")}\n`;
  });
  return ["WEBVTT\n", ...cues].join("\n");
}
