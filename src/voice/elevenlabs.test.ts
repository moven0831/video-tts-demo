import assert from "node:assert/strict";
import { test } from "node:test";
import { createElevenLabs } from "./elevenlabs.ts";

test("construction needs no API key; the first call rejects with the key error", async (t) => {
  const saved = process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
  });
  delete process.env.ELEVENLABS_API_KEY;
  const voice = createElevenLabs();
  await assert.rejects(voice.sfx("click", 1), /ELEVENLABS_API_KEY/);
});
