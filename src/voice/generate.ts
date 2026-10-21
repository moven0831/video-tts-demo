import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { sfxCues, type EditPlan } from "../schema/edit-plan.ts";
import { VoiceManifest, Word } from "../schema/artifacts.ts";
import { writeJson } from "../util/fs.ts";
import { sha256, stableStringify } from "../util/hash.ts";
import type { projectPaths } from "../util/project.ts";
import { wordsFromAlignment } from "./align.ts";
import { cachePath, isCached, writeCached } from "./cache.ts";
import { OUTPUT_FORMAT, type Voice } from "./elevenlabs.ts";

type Paths = ReturnType<typeof projectPaths>;
type Deps = { voice: Voice; duration: (file: string) => Promise<number> };
type Options = {
  yes: boolean;
  dryRun: boolean;
  log: (line: string) => void;
  env: Record<string, string | undefined>;
};

const CHARS_PER_SEC = 15;
// The music API accepts 3000 to 600000 ms; we stop at 300 s.
const MIN_MUSIC_SEC = 3;
const MAX_MUSIC_SEC = 300;

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
  env: Record<string, string | undefined>,
): { voiceId: string; modelId: string } {
  return {
    voiceId:
      voice.voiceId === "default"
        ? env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"
        : voice.voiceId,
    modelId: voice.modelId === "default" ? env.ELEVENLABS_MODEL_ID || "eleven_v4" : voice.modelId,
  };
}

export function lineKey(line: NarrationLine, voiceId: string, modelId: string): string {
  return sha256(
    stableStringify({
      voiceId,
      modelId,
      text: line.text,
      previousText: line.previousText,
      nextText: line.nextText,
      outputFormat: OUTPUT_FORMAT,
    }),
  );
}

const clipKey = (prompt: string, sec: number) => sha256(stableStringify({ prompt, sec }));

export async function runVoice(
  plan: EditPlan,
  { voice, duration }: Deps,
  paths: Paths,
  { yes, dryRun, log, env }: Options,
): Promise<VoiceManifest | undefined> {
  const { voiceId, modelId } = resolveVoice(plan.audio.voice, env);
  const voiceDir = paths.cacheDir("voice");
  const sfxDir = paths.cacheDir("sfx");
  const musicDir = paths.cacheDir("music");
  const rel = (file: string) => relative(paths.build, file);

  const lines = narrationLines(plan);
  const sfx = sfxItems(plan);
  const { music } = plan.audio;
  const musicSec = music.prompt && music.file === null ? estimateVideoSeconds(plan) : undefined;

  if (!yes || dryRun) {
    let chars = 0;
    let uncachedChars = 0;
    let pending = 0;
    for (const line of lines) {
      const cached = await isCached(voiceDir, lineKey(line, voiceId, modelId), "mp3");
      chars += line.text.length;
      if (!cached) {
        uncachedChars += line.text.length;
        pending++;
      }
      log(`${line.id}  ${line.text.length} chars  ${cached ? "cached" : "new"}`);
    }
    log(`lines: ${lines.length}, characters: ${chars}, uncached characters: ${uncachedChars}`);
    for (const item of sfx) {
      const cached = await isCached(sfxDir, clipKey(item.prompt, item.sec), "mp3");
      if (!cached) pending++;
      log(`sfx ${item.id}  ${item.sec} s  ${cached ? "cached" : "new"}`);
    }
    if (musicSec !== undefined && music.prompt) {
      const cached = await isCached(musicDir, clipKey(music.prompt, musicSec), "mp3");
      if (!cached) pending++;
      log(`music  ${musicSec} s  ${cached ? "cached" : "new"}`);
    }
    // A fully cached plan costs nothing, so it falls through and rewrites voice.json.
    if (dryRun || pending > 0) {
      if (!yes) log("nothing generated; pass --yes to generate the new items");
      return undefined;
    }
  }

  const manifest: VoiceManifest = { lines: {}, sfx: {} };
  for (const line of lines) {
    const key = lineKey(line, voiceId, modelId);
    const cached = await isCached(voiceDir, key, "mp3");
    if (!cached) {
      const { audio, alignment } = await voice.tts(line.text, {
        voiceId,
        modelId,
        previousText: line.previousText,
        nextText: line.nextText,
      });
      let words: Word[];
      if (alignment) {
        words = wordsFromAlignment(alignment);
      } else {
        log(`${line.id}: no alignment from tts, using forced alignment`);
        words = await voice.align(audio, line.text);
      }
      // Words land before the mp3, so an mp3 in the cache always has its words.
      await writeCached(voiceDir, key, "align.json", async () => Buffer.from(JSON.stringify(words)));
      await writeCached(voiceDir, key, "mp3", async () => audio);
    }
    const file = cachePath(voiceDir, key, "mp3");
    const words = await readFile(cachePath(voiceDir, key, "align.json"), "utf8");
    manifest.lines[line.id] = {
      file: rel(file),
      duration: await duration(file),
      words: Word.array().parse(JSON.parse(words)),
    };
    log(`${line.id}: ${cached ? "cached" : "generated"}`);
  }

  for (const item of sfx) {
    const file = await writeCached(sfxDir, clipKey(item.prompt, item.sec), "mp3", () =>
      voice.sfx(item.prompt, item.sec),
    );
    manifest.sfx[item.id] = { file: rel(file), duration: await duration(file) };
  }

  if (musicSec !== undefined && music.prompt) {
    const prompt = music.prompt;
    const file = await writeCached(musicDir, clipKey(prompt, musicSec), "mp3", () =>
      voice.music(prompt, musicSec),
    );
    manifest.music = { file: rel(file), duration: await duration(file) };
  } else if (music.file !== null) {
    const file = resolve(paths.music, music.file);
    manifest.music = { file: rel(file), duration: await duration(file) };
  }

  await writeJson(paths.voice, VoiceManifest.parse(manifest));
  return manifest;
}

export async function runAudition(
  { voice }: Pick<Deps, "voice">,
  paths: Paths,
  opts: { text: string; voiceIds: string[]; modelId: string; yes: boolean; log: (line: string) => void },
): Promise<void> {
  const dir = paths.cacheDir("voice");
  const line: NarrationLine = { id: "audition", text: opts.text };
  for (const voiceId of opts.voiceIds) {
    const key = lineKey(line, voiceId, opts.modelId);
    if (!opts.yes) {
      const cached = await isCached(dir, key, "mp3");
      opts.log(`${voiceId}  ${opts.text.length} chars  ${cached ? "cached" : "new"}`);
      continue;
    }
    const file = await writeCached(dir, key, "mp3", async () => {
      const { audio } = await voice.tts(opts.text, { voiceId, modelId: opts.modelId });
      return audio;
    });
    const out = join(paths.build, "audition", `${voiceId}.mp3`);
    await mkdir(join(paths.build, "audition"), { recursive: true });
    await copyFile(file, out);
    opts.log(`wrote ${out}`);
  }
  if (!opts.yes) opts.log("nothing generated; pass --yes to render the clips");
}
