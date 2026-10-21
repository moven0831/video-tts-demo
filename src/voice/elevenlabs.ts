import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Word } from "../schema/artifacts.ts";
import type { CharAlignment } from "./align.ts";

export const OUTPUT_FORMAT = "mp3_44100_128";

export type TtsOptions = {
  voiceId: string;
  modelId: string;
  previousText?: string;
  nextText?: string;
};

export interface Voice {
  tts(text: string, opts: TtsOptions): Promise<{ audio: Buffer; alignment?: CharAlignment }>;
  align(audio: Buffer, text: string): Promise<Word[]>;
  sfx(prompt: string, seconds: number): Promise<Buffer>;
  music(prompt: string, seconds: number): Promise<Buffer>;
}

async function toBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

// The client is built on first use so dry runs work without ELEVENLABS_API_KEY.
export function createElevenLabs(): Voice {
  let instance: ElevenLabsClient | undefined;
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
      return {
        audio: Buffer.from(res.audioBase64, "base64"),
        alignment: res.alignment ?? res.normalizedAlignment,
      };
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
