import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_NEEDS_SPEND, run, runBuffer, runInherited, runMain, runStreaming } from "./exec.ts";

test("runInherited resolves to the exit code, zero or not", async () => {
  assert.equal(await runInherited(process.execPath, ["-e", "process.exit(0)"]), 0);
  assert.equal(await runInherited(process.execPath, ["-e", "process.exit(3)"]), 3);
  await assert.rejects(runStreaming(process.execPath, ["-e", "process.exit(3)"]), /exited with code 3/);
});

test("runInherited gives the child no stdin, so prompts cannot block it", async () => {
  const script = "process.stdin.on('end', () => process.exit(7)); process.stdin.resume()";
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<number>((resolve) => (timer = setTimeout(() => resolve(-1), 3000)));
  const code = await Promise.race([runInherited(process.execPath, ["-e", script]), hung]);
  clearTimeout(timer);
  assert.equal(code, 7);
});

test("runMain prints the message, not a stack, and sets exit code 1", async (t) => {
  const printed: string[] = [];
  t.mock.method(console, "error", (line: string) => printed.push(line));
  t.after(() => (process.exitCode = undefined));
  await runMain(async () => {
    throw new Error("plan needs to spend");
  });
  assert.deepEqual(printed, ["error: plan needs to spend"]);
  assert.equal(process.exitCode, 1);
});

test("runMain leaves the exit code alone when main succeeds or sets its own", async (t) => {
  t.after(() => (process.exitCode = undefined));
  await runMain(async () => {});
  assert.equal(process.exitCode, undefined);
  await runMain(async () => {
    process.exitCode = EXIT_NEEDS_SPEND;
  });
  assert.equal(process.exitCode, EXIT_NEEDS_SPEND);
});

test("runBuffer returns binary stdout untouched", async () => {
  const out = await runBuffer(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0, 255, 128, 10]))",
  ]);
  assert.deepEqual([...out], [0, 255, 128, 10]);
});

test("runBuffer rejects with the stderr tail on a nonzero exit", async () => {
  await assert.rejects(
    runBuffer(process.execPath, ["-e", "console.error('boom'); process.exit(2)"]),
    /exited with code 2\nboom/,
  );
});

test("captures stdout and stderr", async () => {
  const result = await run(process.execPath, [
    "-e",
    "console.log('out'); console.error('err')",
  ]);
  assert.deepEqual(result, { stdout: "out\n", stderr: "err\n", code: 0 });
});

test("passes args verbatim, without a shell", async () => {
  const result = await run(process.execPath, ["-e", "console.log(process.argv[1])", "a b;$HOME"]);
  assert.equal(result.stdout, "a b;$HOME\n");
});

test("merges env over the parent env and honours cwd", async () => {
  const result = await run(
    process.execPath,
    ["-e", "console.log(process.env.DEMO_X, process.cwd())"],
    { env: { DEMO_X: "1" }, cwd: "/" },
  );
  assert.equal(result.stdout, "1 /\n");
});

test("rejects with the stderr tail on a nonzero exit", async () => {
  const script = "for (let i = 0; i < 30; i++) console.error('line' + i); process.exit(3)";
  await assert.rejects(run(process.execPath, ["-e", script]), (err: Error) => {
    assert.match(err.message, /exited with code 3/);
    assert.match(err.message, /line29/);
    assert.match(err.message, /line10/);
    assert.doesNotMatch(err.message, /line9\n/);
    return true;
  });
});

test("rejects when the command does not exist", async () => {
  await assert.rejects(run("definitely-not-a-command-xyz", []), /ENOENT/);
});
