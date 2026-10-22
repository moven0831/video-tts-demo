import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Word } from "../schema/artifacts.ts";
import type { CharAlignment } from "./align.ts";
import { OUTPUT_FORMAT } from "./keys.ts";

export type TtsOptions = {
  voiceId: string;
  modelId: string;
  previousText?: string;
  nextText?: string;
};

export interface Voice {
  // `normalized` marks an alignment of the normalised text, so words may differ from the script.
  tts(
    text: string,
    opts: TtsOptions,
  ): Promise<{ audio: Buffer; alignment?: CharAlignment; normalized?: true }>;
  align(audio: Buffer, text: string): Promise<Word[]>;
  sfx(prompt: string, seconds: number): Promise<Buffer>;
  music(prompt: string, seconds: number): Promise<Buffer>;
}

async function toBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

// The client is built on first use so dry runs work without ELEVENLABS_API_KEY.
export function createElevenLabs(client?: ElevenLabsClient): Voice {
  let instance = client;
  const lazy = () => (instance ??= new ElevenLabsClient());
  return {
    async tts(text, { voiceId, modelId, previousText, nextText }) {
      const res = await lazy().textToSpeech.convertWithTimestamps(voiceId, {
        text,
        modelId,
        previousText,
        nextText,
        outputFormat: OUTPUT_FORMAT,
      });
      const audio = Buffer.from(res.audioBase64, "base64");
      if (res.alignment) return { audio, alignment: res.alignment };
      if (res.normalizedAlignment) return { audio, alignment: res.normalizedAlignment, normalized: true };
      return { audio };
    },
    async align(audio, text) {
      const res = await lazy().forcedAlignment.create({
        file: { data: audio, filename: "line.mp3", contentType: "audio/mpeg" },
        text,
      });
      return res.words.map(({ text, start, end }) => ({ text, start, end }));
    },
    async sfx(prompt, seconds) {
      return toBuffer(
        await lazy().textToSoundEffects.convert({ text: prompt, durationSeconds: seconds }),
      );
    },
    async music(prompt, seconds) {
      return toBuffer(
        await lazy().music.compose({ prompt, musicLengthMs: Math.round(seconds * 1000) }),
      );
    },
  };
}
