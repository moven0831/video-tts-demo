import { spawn } from "node:child_process";

export type RunResult = { stdout: string; stderr: string; code: number };

const TAIL_LINES = 20;

export function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr, code });
      const tail = stderr.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
      reject(new Error(`${cmd} exited with code ${code}\n${tail}`));
    });
  });
}
