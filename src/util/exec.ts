import { spawn } from "node:child_process";

// `code` is 1 when a signal ended the process; `signal` then says which.
export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
};
type Opts = { env?: Record<string, string>; cwd?: string };

const TAIL_LINES = 20;

// A stage that stopped before spending money exits with this code.
export const EXIT_NEEDS_SPEND = 3;

// Entry point wrapper: a failure prints `error: <message>` and exits 1, never a stack trace unless
// DEBUG is set.
export async function runMain(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    if (process.env.DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

function startPiped(cmd: string, args: string[], opts: Opts) {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function describeExit(
  cmd: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal ? `${cmd} killed by ${signal}` : `${cmd} exited with code ${code}`;
}

function failure(
  cmd: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const tail = stderr.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return new Error(`${describeExit(cmd, code, signal)}\n${tail}`);
}

// Unlike run(), a non-zero exit is data: lint prints its report to stdout and exits 1.
export function capture(cmd: string, args: string[], opts: Opts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = startPiped(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ stdout, stderr, code: code ?? 1, signal }));
  });
}

export async function run(cmd: string, args: string[], opts: Opts = {}): Promise<RunResult> {
  const result = await capture(cmd, args, opts);
  if (result.code !== 0) throw failure(cmd, result.code, result.signal, result.stderr);
  return result;
}

export function runBuffer(cmd: string, args: string[], opts: Opts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = startPiped(cmd, args, opts);
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(failure(cmd, code, signal, stderr));
    });
  });
}

// Output goes straight to the terminal; the caller decides what a non-zero code means. stdin is
// /dev/null so a child's prompt (HyperFrames' feedback survey) reads EOF instead of blocking. A
// signal that ends the child rejects, since there is no exit code to judge.
export function runInherited(cmd: string, args: string[], opts: Opts = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) return reject(new Error(describeExit(cmd, code, signal)));
      resolve(code ?? 1);
    });
  });
}

export async function runStreaming(cmd: string, args: string[], opts: Opts = {}): Promise<void> {
  const code = await runInherited(cmd, args, opts);
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
}
