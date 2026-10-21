import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clipName, splitSegments, writeClips } from "./clips.ts";

test("splits on blank lines and trims", () => {
  assert.deepEqual(splitSegments("  one\ntwo  \n\nthree\n"), ["one\ntwo", "three"]);
});

test("treats several blank lines as one separator", () => {
  assert.deepEqual(splitSegments("a\n\n\n\nb"), ["a", "b"]);
});

test("tolerates CRLF", () => {
  assert.deepEqual(splitSegments("a\r\nb\r\n\r\nc\r\n"), ["a\nb", "c"]);
});

test("drops comment lines, keeping the rest of the block", () => {
  assert.deepEqual(splitSegments("# 0:05\nhello\n# note\nworld"), ["hello\nworld"]);
});

test("drops a block that is all comments", () => {
  assert.deepEqual(splitSegments("# intro\n# notes\n\nhello\n\n# outro"), ["hello"]);
});

test("whitespace-only lines separate clips", () => {
  assert.deepEqual(splitSegments("a\n   \nb\n\t\nc\n\u00a0\nd"), ["a", "b", "c", "d"]);
});

test("indented comment lines are dropped", () => {
  assert.deepEqual(splitSegments("  # note\n\t# note\nhello"), ["hello"]);
});

test("empty input has no segments", () => {
  assert.deepEqual(splitSegments(""), []);
  assert.deepEqual(splitSegments("\n \n\n"), []);
});

test("clip names pad to two digits at small counts", () => {
  assert.equal(clipName(0, 1), "01.mp3");
  assert.equal(clipName(8, 9), "09.mp3");
});

test("clip names stay two digits at 10 segments", () => {
  assert.equal(clipName(9, 10), "10.mp3");
});

test("clip names widen past 99 segments", () => {
  assert.equal(clipName(0, 100), "001.mp3");
  assert.equal(clipName(99, 100), "100.mp3");
  assert.equal(clipName(0, 1000), "0001.mp3");
});

type Call = { text: string; previousText?: string; nextText?: string };

function fakeConvert(calls: Call[], failOn?: string, failMidStream = false) {
  return async (text: string, previousText?: string, nextText?: string) => {
    calls.push({ text, previousText, nextText });
    if (text === failOn && !failMidStream) throw new Error("convert failed");
    if (text === failOn) {
      return (async function* () {
        yield new TextEncoder().encode("partial");
        throw new Error("stream failed");
      })();
    }
    return (async function* () {
      yield new TextEncoder().encode(`audio:${text}:`);
      yield new TextEncoder().encode("end");
    })();
  };
}

async function tmpDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tts-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a single segment has no neighbours", async (t) => {
  const dir = await tmpDir(t);
  const calls: Call[] = [];
  await writeClips(["only"], dir, fakeConvert(calls));
  assert.deepEqual(calls, [{ text: "only", previousText: undefined, nextText: undefined }]);
});

test("segments are stitched to their neighbours", async (t) => {
  const dir = await tmpDir(t);
  const calls: Call[] = [];
  await writeClips(["a", "b", "c"], dir, fakeConvert(calls));
  assert.deepEqual(calls, [
    { text: "a", previousText: undefined, nextText: "b" },
    { text: "b", previousText: "a", nextText: "c" },
    { text: "c", previousText: "b", nextText: undefined },
  ]);
});

test("writes numbered files with the streamed bytes and returns their paths", async (t) => {
  const dir = await tmpDir(t);
  const paths = await writeClips(["a", "b"], dir, fakeConvert([]));
  assert.deepEqual(paths, [join(dir, "01.mp3"), join(dir, "02.mp3")]);
  assert.equal(await readFile(paths[0], "utf8"), "audio:a:end");
  assert.equal(await readFile(paths[1], "utf8"), "audio:b:end");
});

test("creates a missing nested output directory", async (t) => {
  const dir = await tmpDir(t);
  const out = join(dir, "x", "y");
  const paths = await writeClips(["a"], out, fakeConvert([]));
  assert.deepEqual(paths, [join(out, "01.mp3")]);
  assert.equal(await readFile(paths[0], "utf8"), "audio:a:end");
});

test("a failing segment rejects but keeps earlier clips", async (t) => {
  const dir = await tmpDir(t);
  const calls: Call[] = [];
  await assert.rejects(writeClips(["a", "b", "c"], dir, fakeConvert(calls, "b")), /convert failed/);
  assert.equal(await readFile(join(dir, "01.mp3"), "utf8"), "audio:a:end");
  assert.equal(calls.length, 2);
});

test("file names stay in order past ten segments", async (t) => {
  const dir = await tmpDir(t);
  const segments = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const paths = await writeClips(segments, dir, fakeConvert([]));
  assert.equal(paths.length, 12);
  assert.equal(paths[9], join(dir, "10.mp3"));
  assert.equal(paths[11], join(dir, "12.mp3"));
  assert.equal(await readFile(paths[11], "utf8"), "audio:s11:end");
});

test("a stream that fails midway leaves no clip or .part under its name", async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(writeClips(["a", "b"], dir, fakeConvert([], "b", true)), /stream failed/);
  assert.equal(await readFile(join(dir, "01.mp3"), "utf8"), "audio:a:end");
  assert.deepEqual(await readdir(dir), ["01.mp3"]);
});

test("a failure keeps a clip left by an earlier run", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "02.mp3"), "old");
  await assert.rejects(writeClips(["a", "b"], dir, fakeConvert([], "b", true)), /stream failed/);
  assert.equal(await readFile(join(dir, "02.mp3"), "utf8"), "old");
  assert.equal(await readFile(join(dir, "01.mp3"), "utf8"), "audio:a:end");
});

test("prunes numbered clips from earlier runs and nothing else", async (t) => {
  const dir = await tmpDir(t);
  for (const name of ["05.mp3", "099.mp3", "intro.mp3", "notes.txt"]) {
    await writeFile(join(dir, name), "old");
  }
  await writeClips(["a", "b"], dir, fakeConvert([]));
  assert.deepEqual((await readdir(dir)).sort(), ["01.mp3", "02.mp3", "intro.mp3", "notes.txt"]);
  assert.equal(await readFile(join(dir, "01.mp3"), "utf8"), "audio:a:end");
  assert.equal(await readFile(join(dir, "02.mp3"), "utf8"), "audio:b:end");
});

test("does not prune when a clip fails", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "05.mp3"), "old");
  await assert.rejects(writeClips(["a", "b"], dir, fakeConvert([], "b")), /convert failed/);
  assert.equal(await readFile(join(dir, "05.mp3"), "utf8"), "old");
});
