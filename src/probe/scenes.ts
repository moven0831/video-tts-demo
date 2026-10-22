import type { SceneCuts } from "../schema/artifacts.ts";
import { run } from "../util/exec.ts";

const THRESHOLD = 0.12;

// The metadata filter prints "frame:N pts:P pts_time:T" then "lavfi.scene_score=S" per selected frame.
export function parseScenes(text: string): SceneCuts {
  const cuts: SceneCuts = [];
  for (const match of text.matchAll(/pts_time:([\d.]+)\s+lavfi\.scene_score=([\d.]+)/g)) {
    cuts.push({ t: Number(match[1]), score: Number(match[2]) });
  }
  return cuts;
}

export async function detectScenes(input: string): Promise<SceneCuts> {
  const { stdout } = await run("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    input,
    "-vf",
    `select='gt(scene,${THRESHOLD})',metadata=print:file=-`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  return parseScenes(stdout);
}
