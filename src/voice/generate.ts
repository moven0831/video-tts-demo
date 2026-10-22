import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { VoiceManifest, Word } from "../schema/artifacts.ts";
import type { EditPlan } from "../schema/edit-plan.ts";
import { writeAtomic, writeJson } from "../util/fs.ts";
import type { ProjectPaths } from "../util/project.ts";
import { wordsFromAlignment } from "./align.ts";
import { cachePath, isCached, writeCached } from "./cache.ts";
import type { Voice } from "./elevenlabs.ts";
import {
  describeVoice,
  estimateVideoSeconds,
  lineKey,
  musicFileKey,
  musicKey,
  narrationLines,
  resolveVoice,
  sfxItems,
  sfxKey,
  type NarrationLine,
} from "./keys.ts";

type Deps = { voice: Voice; duration: (file: string) => Promise<number> };
type Options = {
  yes: boolean;
  dryRun: boolean;
  log: (line: string) => void;
  env: Record<string, string | undefined>;
};

export async function runVoice(
  plan: EditPlan,
  { voice, duration }: Deps,
  paths: ProjectPaths,
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

  log(describeVoice(plan.audio.voice, env));

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
      const cached = await isCached(sfxDir, sfxKey(item.prompt, item.sec), "mp3");
      if (!cached) pending++;
      log(`sfx ${item.id}  ${item.sec} s  ${cached ? "cached" : "new"}`);
    }
    if (musicSec !== undefined && music.prompt) {
      const cached = await isCached(musicDir, musicKey(music.prompt, musicSec), "mp3");
      if (!cached) pending++;
      log(`music  ${musicSec} s  ${cached ? "cached" : "new"}`);
    }
    // A fully cached plan costs nothing, so it falls through and rewrites voice.json.
    if (dryRun || pending > 0) {
      if (!yes) log("nothing generated; pass --yes to generate the new items");
      return undefined;
    }
  }

  // A clip that fails here never reaches the cache, where it would be reused on every run.
  const checkClip = (what: string) => async (file: string) => {
    if ((await stat(file)).size === 0) throw new Error(`${what}: the API returned an empty clip`);
    const sec = await duration(file);
    if (!(sec > 0)) throw new Error(`${what}: the API returned a clip with no duration (${sec})`);
  };
  const clipDuration = async (file: string, remedy: string): Promise<number> => {
    const sec = await duration(file).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${file} cannot be read (${reason}); ${remedy}`, { cause: err });
    });
    if (!(sec > 0)) throw new Error(`${file} has duration ${sec}; ${remedy}`);
    return sec;
  };
  const cachedDuration = (file: string) => clipDuration(file, "delete it and rerun");

  // The raw tts audio is cached before alignment, so a failed alignment does not cost a second
  // synthesis on retry. An mp3 in the cache always has its align.json: words land first.
  const generateLine = async (line: NarrationLine, key: string): Promise<void> => {
    const raw = cachePath(voiceDir, key, "tts.mp3");
    let words: Word[] | undefined;
    let audio: Buffer;
    if (await isCached(voiceDir, key, "tts.mp3")) {
      audio = await readFile(raw);
      log(`${line.id}: reusing tts audio from an earlier run`);
    } else {
      const res = await voice.tts(line.text, {
        voiceId,
        modelId,
        previousText: line.previousText,
        nextText: line.nextText,
      });
      audio = res.audio;
      await writeCached(voiceDir, key, "tts.mp3", async () => res.audio, checkClip(line.id));
      if (res.alignment) words = wordsFromAlignment(res.alignment);
      if (res.normalized) log(`${line.id}: alignment is of the normalised text, so captions show it`);
    }
    if (!words) {
      log(`${line.id}: no alignment from tts, using forced alignment`);
      words = await voice.align(audio, line.text);
    }
    // Written unconditionally so a new take never keeps an older take's words.
    await writeAtomic(cachePath(voiceDir, key, "align.json"), JSON.stringify(words));
    await writeCached(voiceDir, key, "mp3", async () => audio);
    await rm(raw, { force: true });
  };

  const manifest: VoiceManifest = { lines: {}, sfx: {} };
  for (const line of lines) {
    const key = lineKey(line, voiceId, modelId);
    const cached = await isCached(voiceDir, key, "mp3");
    if (!cached) await generateLine(line, key);
    const file = cachePath(voiceDir, key, "mp3");
    const words = await readFile(cachePath(voiceDir, key, "align.json"), "utf8");
    manifest.lines[line.id] = {
      file: rel(file),
      key,
      duration: await cachedDuration(file),
      words: Word.array().parse(JSON.parse(words)),
    };
    log(`${line.id}: ${cached ? "cached" : "generated"}`);
  }

  for (const item of sfx) {
    const key = sfxKey(item.prompt, item.sec);
    const file = await writeCached(
      sfxDir,
      key,
      "mp3",
      () => voice.sfx(item.prompt, item.sec),
      checkClip(`sfx ${item.id}`),
    );
    manifest.sfx[item.id] = { file: rel(file), key, duration: await cachedDuration(file) };
  }

  if (musicSec !== undefined && music.prompt) {
    const prompt = music.prompt;
    const key = musicKey(prompt, musicSec);
    const file = await writeCached(
      musicDir,
      key,
      "mp3",
      () => voice.music(prompt, musicSec),
      checkClip("music"),
    );
    manifest.music = { file: rel(file), key, duration: await cachedDuration(file) };
  } else if (music.file !== null) {
    const file = resolve(paths.music, music.file);
    manifest.music = {
      file: rel(file),
      key: musicFileKey(music.file),
      duration: await clipDuration(file, "fix or replace it"),
    };
  }

  await writeJson(paths.voice, VoiceManifest.parse(manifest));
  return manifest;
}

export async function runAudition(
  { voice }: Pick<Deps, "voice">,
  paths: ProjectPaths,
  opts: { text: string; voiceIds: string[]; modelId: string; yes: boolean; log: (line: string) => void },
): Promise<void> {
  const dir = paths.cacheDir("voice");
  const line: NarrationLine = { id: "audition", text: opts.text };
  for (const voiceId of opts.voiceIds) {
    const key = lineKey(line, voiceId, opts.modelId, true);
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
