import assert from "node:assert/strict";
import { test } from "node:test";
import { wordsFromAlignment, type CharAlignment } from "./align.ts";

// One 0.1 s slot per character.
function alignmentOf(text: string): CharAlignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i / 10),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) / 10),
  };
}

const close = (words: { start: number; end: number }[]) =>
  words.map((w) => [Math.round(w.start * 10), Math.round(w.end * 10)]);

test("splits on spaces", () => {
  const words = wordsFromAlignment(alignmentOf("open the app"));
  assert.deepEqual(words.map((w) => w.text), ["open", "the", "app"]);
  assert.deepEqual(close(words), [[0, 4], [5, 8], [9, 12]]);
});

test("keeps punctuation attached to its word", () => {
  const words = wordsFromAlignment(alignmentOf("Hello, world. It's fine!"));
  assert.deepEqual(words.map((w) => w.text), ["Hello,", "world.", "It's", "fine!"]);
});

test("ignores leading and trailing spaces", () => {
  const words = wordsFromAlignment(alignmentOf("  hi there  "));
  assert.deepEqual(words.map((w) => w.text), ["hi", "there"]);
  assert.deepEqual(close(words), [[2, 4], [5, 10]]);
});

test("collapses multiple spaces and newlines", () => {
  const words = wordsFromAlignment(alignmentOf("a   b\n\nc"));
  assert.deepEqual(words.map((w) => w.text), ["a", "b", "c"]);
});

test("empty input has no words", () => {
  assert.deepEqual(
    wordsFromAlignment({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] }),
    [],
  );
  assert.deepEqual(wordsFromAlignment(alignmentOf("   ")), []);
});
