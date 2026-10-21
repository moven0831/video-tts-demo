import { spawn } from "node:child_process";

export type RunResult = { stdout: string; stderr: string; code: number };
type Opts = { env?: Record<string, string>; cwd?: string };

const TAIL_LINES = 20;

function start(cmd: string, args: string[], opts: Opts, out: "pipe" | "inherit") {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", out, out === "pipe" ? "pipe" : "inherit"],
  });
}

function failure(cmd: string, code: number | null, stderr: string): Error {
  const tail = stderr.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return new Error(`${cmd} exited with code ${code}\n${tail}`);
}

// Unlike run(), a non-zero exit is data: lint prints its report to stdout and exits 1.
export function capture(cmd: string, args: string[], opts: Opts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = start(cmd, args, opts, "pipe");
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export async function run(cmd: string, args: string[], opts: Opts = {}): Promise<RunResult> {
  const result = await capture(cmd, args, opts);
  if (result.code !== 0) throw failure(cmd, result.code, result.stderr);
  return result;
}

export function runBuffer(cmd: string, args: string[], opts: Opts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = start(cmd, args, opts, "pipe");
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(failure(cmd, code, stderr));
    });
  });
}

export function runStreaming(cmd: string, args: string[], opts: Opts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start(cmd, args, opts, "inherit");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
