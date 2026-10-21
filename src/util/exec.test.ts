import assert from "node:assert/strict";
import { test } from "node:test";
import { run, runBuffer } from "./exec.ts";

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
