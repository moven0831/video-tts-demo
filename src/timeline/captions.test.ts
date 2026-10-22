import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../schema/artifacts.ts";
import { buildCaptions, toSrt, toVtt } from "./captions.ts";

// Evenly spaced words starting at `start`, `step` seconds each.
function speak(text: string, start = 0, step = 0.3): Word[] {
  return text.split(" ").map((word, i) => ({
    text: word,
    start: start + i * step,
    end: start + (i + 1) * step,
  }));
}

test("every cue respects line length, line count and reading speed", () => {
  const text = Array.from({ length: 12 }, () => "Open the settings panel and then choose").join(" ");
  const cues = buildCaptions(speak(text));
  assert.ok(cues.length > 1);
  for (const cue of cues) {
    assert.ok(cue.lines.length <= 2, cue.lines.join(" | "));
    for (const line of cue.lines) assert.ok(line.length <= 42, line);
    const chars = cue.lines.join(" ").length;
    assert.ok(chars / (cue.end - cue.start) <= 20 + 1e-9, cue.lines.join(" | "));
  }
});

test("fast speech is split to keep reading speed under 20 characters per second", () => {
  const cues = buildCaptions(speak("Copy the file and paste it into the folder", 0, 0.1));
  assert.deepEqual(
    cues.map((c) => c.lines),
    [["Copy the file"], ["and paste it into the folder"]],
  );
});

test("cues break at sentence ends", () => {
  const cues = buildCaptions([...speak("Open the app.", 0), ...speak("Then click save.", 1.2)]);
  assert.deepEqual(
    cues.map((c) => c.lines),
    [["Open the app."], ["Then click save."]],
  );
});

test("a long gap breaks a cue even without punctuation", () => {
  const cues = buildCaptions([...speak("Open the app", 0), ...speak("then click save", 3)]);
  assert.deepEqual(
    cues.map((c) => c.lines),
    [["Open the app"], ["then click save"]],
  );
});

test("two lines break at a comma when one fits", () => {
  const cues = buildCaptions(speak("Open the settings panel, then choose the account tab from the menu"));
  assert.deepEqual(cues[0].lines, ["Open the settings panel,", "then choose the account tab from the menu"]);
});

test("two lines break before a conjunction when there is no comma", () => {
  const cues = buildCaptions(speak("Open the settings panel and choose the account tab from the menu"));
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].lines, [
    "Open the settings panel",
    "and choose the account tab from the menu",
  ]);
});

test("a line never breaks mid-word", () => {
  const text = "internationalization configuration documentation infrastructure";
  const [cue] = buildCaptions(speak(text, 0, 0.8));
  assert.deepEqual(cue.lines.join(" ").split(" "), text.split(" "));
});

test("a cue holds for 1.8 s, or speech plus 0.6 s when longer", () => {
  const [short] = buildCaptions(speak("Hi there", 2, 0.25));
  assert.equal(short.start, 2);
  assert.ok(Math.abs(short.end - 3.8) < 1e-9);

  const [long] = buildCaptions(speak("Take your time with this one", 1, 0.5));
  assert.ok(Math.abs(long.end - (1 + 3 + 0.6)) < 1e-9);
});

test("a cue ends before the next one starts", () => {
  const cues = buildCaptions([...speak("Open it.", 0, 0.25), ...speak("Save it.", 0.7, 0.25)]);
  assert.equal(cues[0].end, cues[1].start);
});

test("SRT output is exact", () => {
  const srt = toSrt([
    { start: 1, end: 3.5, lines: ["Hello there"] },
    { start: 3661.25, end: 3662, lines: ["one", "two"] },
  ]);
  assert.equal(
    srt,
    "1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n01:01:01,250 --> 01:01:02,000\none\ntwo\n",
  );
});

test("VTT output is exact", () => {
  const vtt = toVtt([
    { start: 1, end: 3.5, lines: ["Hello there"] },
    { start: 3661.25, end: 3662, lines: ["one", "two"] },
  ]);
  assert.equal(
    vtt,
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there\n\n01:01:01.250 --> 01:01:02.000\none\ntwo\n",
  );
});

test("timestamps round to the nearest millisecond", () => {
  assert.match(toSrt([{ start: 0.0004, end: 1.9996, lines: ["x"] }]), /00:00:00,000 --> 00:00:02,000/);
});
