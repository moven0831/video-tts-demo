import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writeCached } from "./cache.ts";

async function tmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cache-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a miss produces the file and returns its path", async (t) => {
  const dir = await tmpDir(t);
  const path = await writeCached(dir, "k1", "mp3", async () => Buffer.from("audio"));
  assert.equal(path, join(dir, "k1.mp3"));
  assert.equal(await readFile(path, "utf8"), "audio");
});

test("a hit returns the existing file without calling produce", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "k1.mp3"), "old");
  const path = await writeCached(dir, "k1", "mp3", async () => {
    throw new Error("produce must not run");
  });
  assert.equal(await readFile(path, "utf8"), "old");
});

test("creates a missing nested directory", async (t) => {
  const dir = await tmpDir(t);
  const path = await writeCached(join(dir, "x", "y"), "k", "align.json", async () => Buffer.from("{}"));
  assert.equal(path, join(dir, "x", "y", "k.align.json"));
});

test("a failing produce leaves neither the file nor a .part", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "keep.mp3"), "kept");
  await assert.rejects(
    writeCached(dir, "bad", "mp3", async () => {
      throw new Error("convert failed");
    }),
    /convert failed/,
  );
  assert.deepEqual(await readdir(dir), ["keep.mp3"]);
});

test("a stale .part from a crashed run is not a hit and is replaced", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "k.mp3.part"), "half");
  const path = await writeCached(dir, "k", "mp3", async () => Buffer.from("whole"));
  assert.equal(await readFile(path, "utf8"), "whole");
  assert.deepEqual(await readdir(dir), ["k.mp3"]);
});
