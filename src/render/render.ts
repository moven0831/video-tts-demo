import { fileURLToPath } from "node:url";
import { rename, rm } from "node:fs/promises";
import { run } from "../util/exec.ts";
import { capture, runStreaming } from "./spawn.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin/hyperframes", import.meta.url));
const ENV = { HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_SKIP_SKILLS: "1" };

type Finding = { code: string; severity: string; file?: string; message: string };

export function lintProblems(stdout: string): string[] {
  const report = JSON.parse(stdout) as {
    ok: boolean;
    warningCount: number;
    findings: Finding[];
  };
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
    "--fps", "30",
    "--quality", draft ? "draft" : "looks",
    "--video-frame-format", "png",
    "--workers", "1",
    "--strict",
  ];
}

export async function lint(hf: string): Promise<void> {
  const { stdout, stderr, code } = await capture(BIN, ["lint", hf, "--json"], { env: ENV });
  if (!stdout.trim()) throw new Error(`hyperframes lint exited with code ${code}\n${stderr}`);
  const problems = lintProblems(stdout);
  if (problems.length > 0) throw new Error(`hyperframes lint failed\n${problems.join("\n")}`);
}

export async function render(hf: string, output: string, draft: boolean): Promise<void> {
  await lint(hf);
  const part = `${output}.part.mp4`;
  await rm(part, { force: true });
  await runStreaming(BIN, renderArgs(hf, part, draft), { env: ENV });
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name", "-of", "csv=p=0", part,
  ]);
  if (!stdout.trim()) throw new Error(`render produced no video stream: ${part}`);
  await rename(part, output);
}
