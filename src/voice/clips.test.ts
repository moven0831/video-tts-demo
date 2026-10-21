import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSegments } from "./clips.ts";

const texts = (input: string) => splitSegments(input).map((s) => s.text);

test("splits on blank lines and trims", () => {
  assert.deepEqual(splitSegments("  one\ntwo  \n\nthree\n"), [
    { text: "one\ntwo" },
    { text: "three" },
  ]);
});

test("treats several blank lines as one separator", () => {
  assert.deepEqual(texts("a\n\n\n\nb"), ["a", "b"]);
});

test("tolerates CRLF", () => {
  assert.deepEqual(texts("a\r\nb\r\n\r\nc\r\n"), ["a\nb", "c"]);
});

test("drops comment lines, keeping the rest of the block", () => {
  assert.deepEqual(splitSegments("# note\nhello\n# note\nworld"), [{ text: "hello\nworld" }]);
});

test("drops a block that is all comments", () => {
  assert.deepEqual(texts("# intro\n# notes\n\nhello\n\n# outro"), ["hello"]);
});

test("whitespace-only lines separate clips", () => {
  assert.deepEqual(texts("a\n   \nb\n\t\nc\n \nd"), ["a", "b", "c", "d"]);
});

test("indented comment lines are dropped", () => {
  assert.deepEqual(texts("  # note\n\t# note\nhello"), ["hello"]);
});

test("empty input has no segments", () => {
  assert.deepEqual(splitSegments(""), []);
  assert.deepEqual(splitSegments("\n \n\n"), []);
});

test("a m:ss comment above a block sets its at", () => {
  assert.deepEqual(splitSegments("# 0:05\nhello\n\n# 1:30\nworld"), [
    { text: "hello", at: 5 },
    { text: "world", at: 90 },
  ]);
});

test("a timestamp comment inside a block sets its at", () => {
  assert.deepEqual(splitSegments("hello\n# 0:12\nworld"), [{ text: "hello\nworld", at: 12 }]);
});

test("h:mm:ss timestamps and trailing comment text", () => {
  assert.deepEqual(splitSegments("# 1:02:03 open the menu\nhello"), [{ text: "hello", at: 3723 }]);
});

test("the first timestamp in a block wins", () => {
  assert.deepEqual(splitSegments("# 0:01\n# 0:09\nhello"), [{ text: "hello", at: 1 }]);
});

test("a timestamp separated by a blank line does not carry over", () => {
  assert.deepEqual(splitSegments("# 0:05\n\nhello"), [{ text: "hello" }]);
});

test("comments that only look like timestamps are plain comments", () => {
  assert.deepEqual(splitSegments("# 12\n# 0:5\n# v1:20x\nhello"), [{ text: "hello" }]);
});
