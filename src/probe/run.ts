import { mkdir, readFile } from "node:fs/promises";
import { Motion, Probe, SceneCuts } from "../schema/artifacts.ts";
import { writeAtomic, writeJson } from "../util/fs.ts";
import { sha256, sha256File } from "../util/hash.ts";
import type { projectPaths } from "../util/project.ts";
import { extractFrames, writeContact, writeSheets } from "./frames.ts";
import { probeVideo } from "./ffprobe.ts";
import { analyseMotion } from "./motion.ts";
import { detectScenes } from "./scenes.ts";

const VERSION = "1";

type Paths = ReturnType<typeof projectPaths>;

async function previousHash(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function runProbe(paths: Paths, opts: { force: boolean }): Promise<"done" | "skipped"> {
  const hash = sha256(`${await sha256File(paths.input)}:${VERSION}`);
  if (!opts.force && (await previousHash(paths.stageHash("probe"))) === hash) return "skipped";

  await mkdir(paths.build, { recursive: true });
  const probe = Probe.parse(await probeVideo(paths.input));
  await writeJson(paths.probe, probe);
  const scenes = SceneCuts.parse(await detectScenes(paths.input));
  await writeJson(paths.scenes, scenes);
  const motion = Motion.parse(await analyseMotion(paths.input, probe));
  await writeJson(paths.motion, motion);

  const count = await extractFrames(paths.input, probe, paths.frames);
  const sheets = await writeSheets(paths.frames, paths.build, count, probe.duration);
  await writeJson(`${paths.sheets}/index.json`, sheets);
  await writeContact(paths.frames, count, paths.contact);

  await writeAtomic(paths.stageHash("probe"), hash);
  return "done";
}
