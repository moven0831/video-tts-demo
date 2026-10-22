import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256, sha256File, stableStringify, statKey } from "./hash.ts";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("sha256 of a string and of its bytes agree", () => {
  assert.equal(sha256("abc"), ABC);
  assert.equal(sha256(new TextEncoder().encode("abc")), ABC);
});

test("sha256File matches sha256 of the contents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hash-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "a.txt");
  await writeFile(file, "abc");
  assert.equal(await sha256File(file), ABC);
});

test("statKey follows size and mtime, not content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hash-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "a.bin");
  const when = new Date(1_700_000_000_000);
  await writeFile(file, "abc");
  await utimes(file, when, when);
  const key = await statKey(file);
  await writeFile(file, "xyz");
  await utimes(file, when, when);
  assert.equal(await statKey(file), key);
  await utimes(file, when, new Date(when.getTime() + 5000));
  assert.notEqual(await statKey(file), key);
  await writeFile(file, "abcd");
  await utimes(file, when, when);
  assert.notEqual(await statKey(file), key);
});

test("stableStringify sorts keys at every depth", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } }), '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
});

test("stableStringify ignores key order", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("stableStringify keeps array order and null", () => {
  assert.equal(stableStringify([3, 1, null]), "[3,1,null]");
});
