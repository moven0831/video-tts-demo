import type { Probe } from "./artifacts.ts";
import type { Box, EditPlan, Scene } from "./edit-plan.ts";

export type Validation = { errors: string[]; warnings: string[] };

const CHARS_PER_SEC = 15;
const MAX_VISIBLE_CALLOUTS = 2;
const SOURCE_TOLERANCE = { width: 0, height: 0, fps: 0.01, duration: 0.05 };

export function clampBox(box: Box, frame: Pick<Probe, "width" | "height">): Box | null {
  const x = Math.max(box.x, 0);
  const y = Math.max(box.y, 0);
  const right = Math.min(box.x + box.w, frame.width);
  const bottom = Math.min(box.y + box.h, frame.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

export function validatePlan(plan: EditPlan, probe: Probe): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = { chapter: new Set<string>(), scene: new Set<string>(), line: new Set<string>() };
  const unique = (kind: keyof typeof seen, id: string, path: string) => {
    if (seen[kind].has(id)) errors.push(`${path}: duplicate ${kind} id "${id}"`);
    seen[kind].add(id);
  };
  const checkLines = (lines: { id: string; at?: number }[], path: string, window?: Scene["source"]) => {
    for (const [i, line] of lines.entries()) {
      unique("line", line.id, `${path}[${i}]`);
      if (line.at !== undefined && window) inWindow(line.at, window, `${path}[${i}].at`);
    }
  };
  const inWindow = (t: number, window: Scene["source"], path: string) => {
    if (t < window.in || t > window.out) {
      errors.push(`${path}: ${t} is outside the scene window ${window.in}-${window.out}`);
    }
  };
  const checkBox = (box: Box, path: string) => {
    const clamped = clampBox(box, probe);
    if (clamped === null) errors.push(`${path}: box does not intersect the frame`);
    else if (clamped.x !== box.x || clamped.y !== box.y || clamped.w !== box.w || clamped.h !== box.h) {
      warnings.push(`${path}: box clamped to the frame`);
    }
  };

  const { source } = plan.meta;
  for (const key of ["width", "height", "fps", "duration"] as const) {
    if (Math.abs(source[key] - probe[key]) > SOURCE_TOLERANCE[key]) {
      warnings.push(
        `meta.source.${key} is ${source[key]} but the recording is ${probe[key]}; ` +
          "it may have been replaced after planning",
      );
    }
  }

  if (plan.intro) checkLines(plan.intro.narration, "intro.narration");

  let previousOut = 0;
  for (const [ci, chapter] of plan.chapters.entries()) {
    const chapterPath = `chapters[${ci}]`;
    unique("chapter", chapter.id, chapterPath);
    if (chapter.card) checkLines(chapter.card.narration, `${chapterPath}.card.narration`);

    for (const [si, scene] of chapter.scenes.entries()) {
      const path = `${chapterPath}.scenes[${si}]`;
      const window = scene.source;
      unique("scene", scene.id, path);

      if (window.in >= window.out) {
        errors.push(`${path}.source: in ${window.in} must be before out ${window.out}`);
      }
      if (window.out > probe.duration) {
        errors.push(`${path}.source: out ${window.out} is past the source duration ${probe.duration}`);
      }
      if (window.in < previousOut) {
        errors.push(`${path}.source: in ${window.in} overlaps the previous scene ending at ${previousOut}`);
      }
      previousOut = Math.max(previousOut, window.out);

      checkLines(scene.narration, `${path}.narration`, window);

      for (const [i, key] of scene.camera.entries()) {
        inWindow(key.t, window, `${path}.camera[${i}].t`);
        if (key.box) checkBox(key.box, `${path}.camera[${i}].box`);
      }
      for (const [i, click] of scene.clicks.entries()) {
        inWindow(click.t, window, `${path}.clicks[${i}].t`);
      }
      for (const [i, callout] of scene.callouts.entries()) {
        const calloutPath = `${path}.callouts[${i}]`;
        inWindow(callout.t0, window, `${calloutPath}.t0`);
        inWindow(callout.t1, window, `${calloutPath}.t1`);
        if (callout.t0 >= callout.t1) {
          errors.push(`${calloutPath}: t0 ${callout.t0} must be before t1 ${callout.t1}`);
        }
        checkBox(callout.box, `${calloutPath}.box`);

        const move = scene.camera.findIndex(
          (key) => key.t < callout.t1 && callout.t0 < key.t + plan.style.camera.moveSec,
        );
        if (move >= 0) warnings.push(`${calloutPath}: window overlaps camera move camera[${move}]`);
      }
      const crowded = scene.callouts.find(
        (c) => scene.callouts.filter((o) => o.t0 <= c.t0 && c.t0 < o.t1).length > MAX_VISIBLE_CALLOUTS,
      );
      if (crowded) {
        warnings.push(`${path}.callouts: more than ${MAX_VISIBLE_CALLOUTS} visible at t=${crowded.t0}`);
      }

      const chars = scene.narration.reduce((sum, line) => sum + line.text.length, 0);
      const estimate = chars / CHARS_PER_SEC;
      const length = window.out - window.in;
      if (estimate > length + 6) {
        warnings.push(
          `${path}.narration: about ${estimate.toFixed(1)} s of speech for a ${length} s scene`,
        );
      }
    }
  }

  if (plan.outro) checkLines(plan.outro.narration, "outro.narration");

  const scenes = new Map<string, Scene["source"]>();
  for (const { id, source } of plan.chapters.flatMap((chapter) => chapter.scenes)) {
    if (!scenes.has(id)) scenes.set(id, source);
  }
  for (const [i, cue] of plan.audio.sfx.entries()) {
    const window = scenes.get(cue.scene);
    if (window === undefined) errors.push(`audio.sfx[${i}].scene: no scene "${cue.scene}"`);
    else inWindow(cue.t, window, `audio.sfx[${i}].t`);
  }

  const { music } = plan.audio;
  if (music.file !== null && music.prompt) {
    warnings.push("audio.music: both file and prompt are set; the file is used and the prompt ignored");
  }
  if (plan.style.font !== "Inter") {
    warnings.push(`style.font: only Inter is bundled, "${plan.style.font}" falls back to a system font`);
  }
  return { errors, warnings };
}
