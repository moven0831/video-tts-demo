import type { Probe, VoiceManifest, Word } from "../schema/artifacts.ts";
import type { Card, EditPlan, Line, Scene } from "../schema/edit-plan.ts";
import {
  boxToStage,
  buildCamera,
  cameraTransform,
  containFit,
  pointToStage,
  type CameraKey,
} from "./camera.ts";
import { buildCaptions } from "./captions.ts";
import { duckingLane } from "./ducking.ts";
import { Timeline } from "./types.ts";

const LEAD_IN_SEC = 0.2;
const CARD_TAIL_SEC = 0.6;
const FREEZE_TAIL_SEC = 0.6;
const TRIM_TAIL_SEC = 0.8;
const MAX_FREEZE_SEC = 6;
const MIN_RATE = 0.5;
const EPSILON = 1e-6;

type SegmentPlan = { rate: number; videoSec: number; freezeSec: number; total: number };
type Transition = EditPlan["chapters"][number]["transition"];

function planSegment(fit: Scene["fit"], sourceSec: number, speechSec: number): SegmentPlan {
  if (speechSec <= sourceSec) {
    const videoSec = fit === "trim" ? Math.min(sourceSec, speechSec + TRIM_TAIL_SEC) : sourceSec;
    return { rate: 1, videoSec, freezeSec: 0, total: videoSec };
  }
  if (fit === "slow") {
    const rate = Math.max(MIN_RATE, sourceSec / speechSec);
    const videoSec = sourceSec / rate;
    return { rate, videoSec, freezeSec: Math.max(0, speechSec - videoSec), total: speechSec };
  }
  const freezeSec = speechSec - sourceSec + FREEZE_TAIL_SEC;
  return { rate: 1, videoSec: sourceSec, freezeSec, total: sourceSec + freezeSec };
}

function round(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(round);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, round(item)]));
}

export function buildTimeline(
  plan: EditPlan,
  probe: Probe,
  voice: VoiceManifest,
): { timeline: Timeline; warnings: string[] } {
  const stage = plan.meta.output;
  const maxZoom = plan.style.camera.maxZoom;
  const fit = containFit(probe, stage);
  const warnings: string[] = [];
  const out = {
    segments: [] as Timeline["segments"],
    clicks: [] as Timeline["clicks"],
    callouts: [] as Timeline["callouts"],
    cards: [] as Timeline["cards"],
    transitions: [] as Timeline["transitions"],
    narration: [] as Timeline["narration"],
    sfx: [] as Timeline["sfx"],
  };
  const cameraKeys: CameraKey[] = [];
  const words: Word[] = [];

  let cursor = 0;
  let total = 0;
  let lastDuration = 0;
  let lastNarrationEnd = 0;
  let pending: { chapter: string; transition: Transition } | null = null;
  let cameraAtRest = true;

  const voiceLine = (id: string) => {
    const entry = voice.lines[id];
    if (!entry) throw new Error(`voice.json has no line "${id}"`);
    return entry;
  };
  const speechLength = (lines: Line[]) =>
    LEAD_IN_SEC + lines.reduce((sum, l) => sum + voiceLine(l.id).duration + l.pauseAfter, 0);

  // Cards and the middle of a black gap hide the video, so a reset there is invisible.
  const resetCamera = (t: number) => {
    if (cameraAtRest) return;
    cameraKeys.push({ t, box: null, instant: true });
    cameraAtRest = true;
  };

  const beginItem = (next: "card" | "scene"): number => {
    if (pending) {
      const { kind, sec } = pending.transition;
      if (next === "scene" && kind !== "fade-black" && !cameraAtRest) {
        warnings.push(
          `chapter "${pending.chapter}" ends zoomed in; add a box: null camera key before it ends`,
        );
      }
      if (kind === "fade-black") resetCamera(cursor + sec / 2);
      if (kind === "cut") {
        out.transitions.push({ kind, at: cursor, duration: 0 });
      } else if (kind === "fade-black") {
        out.transitions.push({ kind, at: cursor, duration: sec });
        cursor += sec;
      } else {
        if (kind === "push") warnings.push("push transition is not implemented; using dissolve");
        const overlap = Math.min(sec, lastDuration);
        cursor -= overlap;
        out.transitions.push({ kind, at: cursor, duration: overlap });
      }
      pending = null;
    }
    if (next === "card") resetCamera(cursor);
    return cursor;
  };
  const endItem = (start: number, duration: number) => {
    cursor = start + duration;
    lastDuration = duration;
    total = Math.max(total, cursor);
  };

  const addNarration = (line: Line, start: number) => {
    const entry = voiceLine(line.id);
    if (start < lastNarrationEnd - EPSILON) {
      warnings.push(`narration "${line.id}" starts before the previous line ends`);
    }
    lastNarrationEnd = Math.max(lastNarrationEnd, start + entry.duration);
    out.narration.push({ lineId: line.id, file: entry.file, start, duration: entry.duration });
    for (const word of entry.words) {
      words.push({ text: word.text, start: start + word.start, end: start + word.end });
    }
  };

  const placeCard = (id: string, card: Card) => {
    const start = beginItem("card");
    let at = start + LEAD_IN_SEC;
    for (const line of card.narration) {
      addNarration(line, at);
      at += voiceLine(line.id).duration + line.pauseAfter;
    }
    const duration =
      card.narration.length > 0
        ? Math.max(card.sec, speechLength(card.narration) + CARD_TAIL_SEC)
        : card.sec;
    out.cards.push({
      id,
      kind: card.kind,
      title: card.title,
      ...(card.subtitle === undefined ? {} : { subtitle: card.subtitle }),
      start,
      duration,
    });
    endItem(start, duration);
  };

  const sfxCount = new Map<string, number>();
  const placeScene = (scene: Scene) => {
    const start = beginItem("scene");
    const { in: sourceIn, out: sourceOut } = scene.source;
    const sourceSec = sourceOut - sourceIn;

    const layout = (segment: SegmentPlan) => {
      const toLocal = (t: number) =>
        (Math.min(Math.max(t, sourceIn), sourceIn + segment.videoSec * segment.rate) - sourceIn) /
        segment.rate;
      let at = LEAD_IN_SEC;
      const placed = scene.narration.map((line) => {
        const lineStart = Math.max(at, line.at === undefined ? 0 : toLocal(line.at));
        at = lineStart + voiceLine(line.id).duration + line.pauseAfter;
        return { line, start: lineStart };
      });
      return { placed, end: at, toLocal };
    };

    let speechSec = speechLength(scene.narration);
    let segment = planSegment(scene.fit, sourceSec, speechSec);
    let laid = layout(segment);
    // Pushing a line later can grow the scene, which can change the rate and move `at` again.
    for (let i = 0; i < 8 && laid.end - speechSec > EPSILON; i++) {
      speechSec = laid.end;
      segment = planSegment(scene.fit, sourceSec, speechSec);
      laid = layout(segment);
    }
    const duration = Math.max(segment.total, laid.end);
    const freezeSec = segment.freezeSec + (duration - segment.total);
    const toOut = (t: number) => start + laid.toLocal(t);

    if (freezeSec > MAX_FREEZE_SEC) {
      warnings.push(`scene "${scene.id}" freezes the last frame for ${freezeSec.toFixed(1)} s`);
    }
    out.segments.push({
      scene: scene.id,
      start,
      end: start + duration,
      in: sourceIn,
      out: sourceIn + segment.videoSec * segment.rate,
      rate: segment.rate,
      ...(freezeSec > EPSILON
        ? {
            freeze: {
              at: Math.max(sourceIn, sourceOut - 1 / probe.fps),
              start: start + segment.videoSec,
              duration: freezeSec,
            },
          }
        : {}),
    });

    for (const { line, start: lineStart } of laid.placed) addNarration(line, start + lineStart);
    for (const key of [...scene.camera].sort((a, b) => a.t - b.t)) {
      cameraKeys.push({ t: toOut(key.t), box: key.box });
      const { scale, x, y } = cameraTransform(key.box, fit, stage, probe, maxZoom);
      cameraAtRest = scale === 1 && x === 0 && y === 0;
    }
    for (const click of scene.clicks) {
      const point = pointToStage(fit, click.x, click.y);
      out.clicks.push({ t: toOut(click.t), ...point, kind: click.kind });
    }
    for (const callout of scene.callouts) {
      out.callouts.push({
        box: boxToStage(fit, callout.box),
        label: callout.label,
        kind: callout.kind,
        side: callout.side,
        t0: toOut(callout.t0),
        t1: toOut(callout.t1),
      });
    }
    for (const cue of plan.audio.sfx.filter((s) => s.scene === scene.id)) {
      const index = sfxCount.get(scene.id) ?? 0;
      sfxCount.set(scene.id, index + 1);
      const id = `${scene.id}-${index}`;
      const entry = voice.sfx[id];
      if (!entry) throw new Error(`voice.json has no sfx "${id}"`);
      out.sfx.push({ id, file: entry.file, start: toOut(cue.t), duration: entry.duration });
    }
    endItem(start, duration);
  };

  if (plan.intro) placeCard("intro", plan.intro);
  for (const chapter of plan.chapters) {
    if (chapter.card) placeCard(chapter.id, chapter.card);
    for (const scene of chapter.scenes) placeScene(scene);
    pending = { chapter: chapter.id, transition: chapter.transition };
  }
  // A transition with nothing after it is dropped.
  if (plan.outro) placeCard("outro", plan.outro);

  const sceneIds = new Set(out.segments.map((s) => s.scene));
  for (const cue of plan.audio.sfx) {
    if (!sceneIds.has(cue.scene)) throw new Error(`sfx refers to unknown scene "${cue.scene}"`);
  }

  const captions = buildCaptions(words).map((cue) => ({ ...cue, end: Math.min(cue.end, total) }));
  const musicFile = voice.music?.file ?? plan.audio.music.file;
  const music = musicFile
    ? {
        file: musicFile,
        gainDb: plan.audio.music.gainDb,
        lane: duckingLane(
          out.narration.map((n) => ({ start: n.start, end: n.start + n.duration })),
          total,
          plan.audio.music.gainDb,
          plan.audio.music.duckDb,
        ),
      }
    : undefined;

  const camera = buildCamera(cameraKeys, {
    source: probe,
    stage,
    fit,
    maxZoom,
    moveSec: plan.style.camera.moveSec,
  });

  const timeline = Timeline.parse(
    round({
      total,
      stage: { width: stage.width, height: stage.height },
      fit,
      ...out,
      camera,
      captions,
      ...(music ? { music } : {}),
    }),
  );
  return { timeline, warnings };
}
