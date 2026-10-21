import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { readJson, writeAtomic } from "./fs.ts";

async function tmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fs-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("writeAtomic writes the data and leaves no .part", async (t) => {
  const dir = await tmpDir(t);
  await writeAtomic(join(dir, "a.txt"), "hello");
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hello");
  assert.deepEqual(await readdir(dir), ["a.txt"]);
});

test("writeAtomic creates missing directories and replaces existing files", async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, "x", "y", "a.bin");
  await writeAtomic(file, new Uint8Array([1, 2]));
  await writeAtomic(file, new Uint8Array([3]));
  assert.deepEqual([...(await readFile(file))], [3]);
});

test("writeAtomic leaves the old file and no .part when the write fails", async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, "a.txt");
  await writeFile(file, "old");
  await assert.rejects(writeAtomic(file, 5 as unknown as string));
  assert.equal(await readFile(file, "utf8"), "old");
  assert.deepEqual(await readdir(dir), ["a.txt"]);
});

test("readJson returns parsed and defaulted data", async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, "a.json");
  await writeFile(file, '{"n":1}');
  const schema = z.object({ n: z.number(), s: z.string().default("x") });
  assert.deepEqual(await readJson(file, schema), { n: 1, s: "x" });
});

test("readJson rejects data that fails the schema", async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, "a.json");
  await writeFile(file, '{"n":"one"}');
  await assert.rejects(readJson(file, z.object({ n: z.number() })), z.ZodError);
});
