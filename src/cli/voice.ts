import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { readFile } from "node:fs/promises";
import { splitSegments, writeClips } from "../voice/clips.ts";

const narrationPath = process.argv[2] ?? "narration.txt";
const outDir = process.argv[3] ?? "audio";
const voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // George
const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_v4";

const segments = splitSegments(await readFile(narrationPath, "utf8"));
if (segments.length === 0) {
  throw new Error(`No narration segments found in ${narrationPath}`);
}

const client = new ElevenLabsClient();
await writeClips(segments, outDir, (text, previousText, nextText) =>
  client.textToSpeech.convert(voiceId, { text, modelId, previousText, nextText }),
);
