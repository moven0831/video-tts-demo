import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BetaImageBlockParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { readJson } from "../util/fs.ts";

const sec = z.number().min(0);
const px = z.number().int().min(0);

export const SheetIndex = z.array(
  z.object({
    file: z.string(),
    t0: sec,
    t1: sec,
    tiles: z.array(z.object({ t: sec, x: px, y: px, w: px.min(1), h: px.min(1) })),
  }),
);
export type SheetIndex = z.infer<typeof SheetIndex>;

export type Sheets = {
  content: (BetaTextBlockParam | BetaImageBlockParam)[];
  sizes: { width: number; height: number }[];
};

function clock(t: number): string {
  const whole = Math.floor(t);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// The index has no sheet pixel size, so sizes are the extent of the tiles; this undercounts a
// partly filled last sheet, which probe pads to the full canvas.
// `file` in the index is relative to the build dir, as probe writes it.
export async function loadSheets(indexPath: string, buildDir: string): Promise<Sheets> {
  const index = await readJson(indexPath, SheetIndex);
  const sorted = [...index].sort((a, b) => a.t0 - b.t0 || (a.file < b.file ? -1 : 1));
  const sheets: Sheets = { content: [], sizes: [] };
  for (const [i, sheet] of sorted.entries()) {
    const tiles = [...sheet.tiles].sort((a, b) => a.y - b.y || a.x - b.x);
    const times = tiles.map((tile) => `${tile.t}s`).join(", ");
    sheets.content.push({
      type: "text",
      text:
        `Sheet ${i + 1}: ${clock(sheet.t0)}–${clock(sheet.t1)}; tiles left-to-right, ` +
        `top-to-bottom at ${times}; each tile is ${tiles[0].w}x${tiles[0].h} px`,
    });
    const data = (await readFile(join(buildDir, sheet.file))).toString("base64");
    sheets.content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data },
    });
    sheets.sizes.push({
      width: Math.max(...tiles.map((tile) => tile.x + tile.w)),
      height: Math.max(...tiles.map((tile) => tile.y + tile.h)),
    });
  }
  return sheets;
}
