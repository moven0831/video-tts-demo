import { sfxCues, type EditPlan } from "../schema/edit-plan.ts";
import type { VoiceManifest } from "../schema/artifacts.ts";
import { sha256, stableStringify } from "../util/hash.ts";

// Pure on purpose: staleVoice runs in stages that must not load the ElevenLabs SDK.
type Env = Record<string, string | undefined>;

export const OUTPUT_FORMAT = "mp3_44100_128";
export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_MODEL_ID = "eleven_v4";

const CHARS_PER_SEC = 15;
// The API range is 3000 to 600000 ms; we stop at 300 s to bound what one bed costs.
const MIN_MUSIC_SEC = 3;
const MAX_MUSIC_SEC = 300;

// previousText and nextText condition each line on the neighbours it is heard next to.
export type NarrationLine = {
  id: string;
  text: string;
  previousText?: string;
  nextText?: string;
};

// Output order: intro card, then per chapter its card and scenes, then the outro card.
export function narrationLines(plan: EditPlan): NarrationLine[] {
  const lines = [
    ...(plan.intro?.narration ?? []),
    ...plan.chapters.flatMap((chapter) => [
      ...(chapter.card?.narration ?? []),
      ...chapter.scenes.flatMap((scene) => scene.narration),
    ]),
    ...(plan.outro?.narration ?? []),
  ];
  return lines.map(({ id, text }, i) => ({
    id,
    text,
    previousText: lines[i - 1]?.text,
    nextText: lines[i + 1]?.text,
  }));
}

export function estimateVideoSeconds(plan: EditPlan): number {
  let total = (plan.intro?.sec ?? 0) + (plan.outro?.sec ?? 0);
  for (const chapter of plan.chapters) {
    total += chapter.card?.sec ?? 0;
    for (const scene of chapter.scenes) {
      const chars = scene.narration.reduce((sum, line) => sum + line.text.length, 0);
      total += Math.max(scene.source.out - scene.source.in, chars / CHARS_PER_SEC + 1);
    }
  }
  return Math.min(Math.max(Math.ceil(total), MIN_MUSIC_SEC), MAX_MUSIC_SEC);
}

export function sfxItems(plan: EditPlan): { id: string; prompt: string; sec: number }[] {
  return sfxCues(plan).map(({ id, prompt, sec }) => ({ id, prompt, sec }));
}

// The director writes "default" when the brief names no voice or model.
export function resolveVoice(
  voice: { voiceId: string; modelId: string },
  env: Env,
): { voiceId: string; modelId: string } {
  return {
    voiceId:
      voice.voiceId === "default" ? env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID : voice.voiceId,
    modelId:
      voice.modelId === "default" ? env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID : voice.modelId,
  };
}

export function describeVoice(voice: { voiceId: string; modelId: string }, env: Env): string {
  const { voiceId, modelId } = resolveVoice(voice, env);
  const origin = (declared: string, envVar: string, fromEnv: string | undefined) => {
    if (declared !== "default") return "";
    return fromEnv ? ` (from ${envVar})` : ` (built-in default; set ${envVar})`;
  };
  return (
    `voice ${voiceId.slice(0, 4)}…${origin(voice.voiceId, "ELEVENLABS_VOICE_ID", env.ELEVENLABS_VOICE_ID)}, ` +
    `model ${modelId}${origin(voice.modelId, "ELEVENLABS_MODEL_ID", env.ELEVENLABS_MODEL_ID)}`
  );
}

// Audition clips are cached without align.json, so they get their own keys; `audition` is omitted
// when false so narration keys match those already cached.
export function lineKey(
  line: NarrationLine,
  voiceId: string,
  modelId: string,
  audition = false,
): string {
  return sha256(
    stableStringify({
      ...(audition ? { audition } : {}),
      voiceId,
      modelId,
      text: line.text,
      previousText: line.previousText,
      nextText: line.nextText,
      outputFormat: OUTPUT_FORMAT,
    }),
  );
}

export const sfxKey = (prompt: string, sec: number): string =>
  sha256(stableStringify({ prompt, sec }));

export const musicKey = sfxKey;

// A user's music file is keyed by name only; swapping its contents is not detected.
export const musicFileKey = (file: string): string => sha256(stableStringify({ file }));

export function planMusicKey(plan: EditPlan): string | undefined {
  const { music } = plan.audio;
  if (music.file !== null) return musicFileKey(music.file);
  if (music.prompt) return musicKey(music.prompt, estimateVideoSeconds(plan));
  return undefined;
}

// One message per line, sfx cue or the music bed whose manifest key no longer matches the plan.
export function staleVoice(plan: EditPlan, manifest: VoiceManifest, env: Env): string[] {
  const { voiceId, modelId } = resolveVoice(plan.audio.voice, env);
  const stale: string[] = [];
  const compare = (what: string, expected: string, actual: string | undefined) => {
    if (actual === undefined) stale.push(`${what} is missing from voice.json`);
    else if (actual !== expected) stale.push(`${what} changed since voice ran`);
  };
  for (const line of narrationLines(plan)) {
    compare(`line "${line.id}"`, lineKey(line, voiceId, modelId), manifest.lines[line.id]?.key);
  }
  for (const item of sfxItems(plan)) {
    compare(`sfx "${item.id}"`, sfxKey(item.prompt, item.sec), manifest.sfx[item.id]?.key);
  }
  const expected = planMusicKey(plan);
  const actual = manifest.music?.key;
  if (expected === undefined && actual !== undefined) stale.push("music was removed since voice ran");
  else if (expected !== undefined && actual === undefined) stale.push("music was added since voice ran");
  else if (expected !== undefined) compare("music", expected, actual);
  return stale;
}
