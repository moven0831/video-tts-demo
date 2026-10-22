import { fileURLToPath } from "node:url";
import { rename, rm } from "node:fs/promises";
import { OUTPUT_FPS } from "../timeline/grid.ts";
import { capture, describeExit, run, runStreaming } from "../util/exec.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin/hyperframes", import.meta.url));
const ENV = { HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_SKIP_SKILLS: "1" };
const SNIPPET_CHARS = 200;

type Finding = { code: string; severity: string; file?: string; message: string };

export function lintProblems(stdout: string): string[] {
  let report: { ok: boolean; warningCount: number; findings: Finding[] };
  try {
    report = JSON.parse(stdout);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error(`hyperframes lint printed non-JSON: ${stdout.slice(0, SNIPPET_CHARS)}`, {
      cause: err,
    });
  }
  if (report.ok && report.warningCount === 0) return [];
  const lines = report.findings
    .filter((f) => f.severity !== "info")
    .map((f) => `${f.severity} ${f.code}: ${f.message}`);
  return lines.length > 0 ? lines : ["lint reported ok: false"];
}

export function renderArgs(hf: string, output: string, draft: boolean): string[] {
  return [
    "render", hf,
    "--output", output,
    "--fps", String(OUTPUT_FPS),
    "--quality", draft ? "draft" : "looks",
    "--video-frame-format", "png",
    "--workers", "1",
    "--strict",
  ];
}

export async function lint(hf: string): Promise<void> {
  const { stdout, stderr, code, signal } = await capture(BIN, ["lint", hf, "--json"], { env: ENV });
  if (!stdout.trim()) throw new Error(`${describeExit("hyperframes lint", code, signal)}\n${stderr}`);
  const problems = lintProblems(stdout);
  if (problems.length > 0) throw new Error(`hyperframes lint failed\n${problems.join("\n")}`);
}

// `types` is ffprobe's stream codec types, one per line.
export function checkStreams(types: string, audioClips: number, file: string): void {
  const found = types.split("\n").map((line) => line.trim());
  if (!found.includes("video")) throw new Error(`render produced no video stream: ${file}`);
  if (audioClips > 0 && !found.includes("audio")) throw new Error("render produced no audio stream");
}

export async function render(
  hf: string,
  output: string,
  draft: boolean,
  audioClips: number,
): Promise<void> {
  await lint(hf);
  const part = `${output}.part.mp4`;
  await rm(part, { force: true });
  await runStreaming(BIN, renderArgs(hf, part, draft), { env: ENV });
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", part,
  ]);
  checkStreams(stdout, audioClips, part);
  await rename(part, output);
}
