import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let block: string[] = [];
  const endBlock = () => {
    const segment = block.join("\n").trim();
    if (segment !== "") segments.push(segment);
    block = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") endBlock();
    else if (!line.trimStart().startsWith("#")) block.push(line);
  }
  endBlock();
  return segments;
}

export function clipName(index: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")}.mp3`;
}

export async function writeClips(
  segments: string[],
  outDir: string,
  convert: (
    text: string,
    previousText?: string,
    nextText?: string,
  ) => Promise<AsyncIterable<Uint8Array>>,
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const [i, text] of segments.entries()) {
    const file = join(outDir, clipName(i, segments.length));
    const part = `${file}.part`;
    try {
      const audio = await convert(text, segments[i - 1], segments[i + 1]);
      await pipeline(Readable.from(audio), createWriteStream(part));
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    await rename(part, file);
    console.log(`wrote ${file}`);
    files.push(file);
  }

  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const path = join(outDir, entry.name);
    if (entry.isFile() && /^\d+\.mp3$/.test(entry.name) && !files.includes(path)) {
      await rm(path);
      console.log(`removed ${path}`);
    }
  }
  return files;
}
