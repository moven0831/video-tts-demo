import { access, mkdir, readFile } from "node:fs/promises";
import { Motion, Probe, SceneCuts } from "../schema/artifacts.ts";
import { writeAtomic, writeJson } from "../util/fs.ts";
import { sha256, statKey } from "../util/hash.ts";
import type { ProjectPaths } from "../util/project.ts";
import { extractFrames, writeContact, writeSheets } from "./frames.ts";
import { probeVideo, VFR_WARNING } from "./ffprobe.ts";
import { analyseMotion } from "./motion.ts";
import { detectScenes } from "./scenes.ts";

const VERSION = "1";

async function previousHash(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function runProbe(
  paths: ProjectPaths,
  opts: { force: boolean },
): Promise<"done" | "skipped"> {
  const hash = sha256(`${await statKey(paths.input)}:${VERSION}`);
  const outputs = [paths.probe, paths.scenes, paths.motion, paths.sheetsIndex, paths.contact];
  if (
    !opts.force &&
    (await previousHash(paths.stageHash("probe"))) === hash &&
    (await Promise.all(outputs.map(exists))).every(Boolean)
  ) {
    return "skipped";
  }

  await mkdir(paths.build, { recursive: true });
  const probe = Probe.parse(await probeVideo(paths.input));
  await writeJson(paths.probe, probe);
  if (probe.vfr) console.warn(`warning: ${VFR_WARNING}`);
  const scenes = SceneCuts.parse(await detectScenes(paths.input));
  await writeJson(paths.scenes, scenes);
  const motion = Motion.parse(await analyseMotion(paths.input, probe));
  await writeJson(paths.motion, motion);

  const count = await extractFrames(paths.input, probe, paths.frames);
  const sheets = await writeSheets(paths.frames, paths.build, count, probe.duration);
  await writeJson(paths.sheetsIndex, sheets);
  await writeContact(paths.frames, count, paths.contact);

  await writeAtomic(paths.stageHash("probe"), hash);
  return "done";
}
