import type { Word } from "../schema/artifacts.ts";

export type CharAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

export function wordsFromAlignment(alignment: CharAlignment): Word[] {
  const words: Word[] = [];
  let current: Word | undefined;
  for (const [i, char] of alignment.characters.entries()) {
    if (/\s/.test(char)) {
      current = undefined;
      continue;
    }
    if (!current) {
      current = { text: "", start: alignment.characterStartTimesSeconds[i], end: 0 };
      words.push(current);
    }
    current.text += char;
    current.end = alignment.characterEndTimesSeconds[i];
  }
  return words;
}
