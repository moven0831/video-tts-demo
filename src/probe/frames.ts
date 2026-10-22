import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Probe } from "../schema/artifacts.ts";
import { run } from "../util/exec.ts";

const COLS = 3;
const TILES_PER_SHEET = COLS * 3;
const MAX_SHEETS = 20;
const TILE_W = 640;
const TILE_H = 360;
const CONTACT_COLS = 6;
const CONTACT_ROWS = 5;
const CONTACT_TILE_W = 320;
const CONTACT_TILE_H = 180;

export type SheetEntry = {
  file: string;
  t0: number;
  t1: number;
  tiles: { t: number; x: number; y: number; w: number; h: number }[];
};

// Source seconds to show, at most `max`, spread evenly and always including the first and last.
export function tileTimes(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: max }, (_, i) => Math.round((i * (count - 1)) / (max - 1)));
}

export function planSheets(count: number, duration: number): SheetEntry[] {
  const times = tileTimes(count, MAX_SHEETS * TILES_PER_SHEET);
  const sheets: SheetEntry[] = [];
  for (let i = 0; i < times.length; i += TILES_PER_SHEET) {
    const chunk = times.slice(i, i + TILES_PER_SHEET);
    const next = times[i + TILES_PER_SHEET];
    sheets.push({
      file: `sheets/${String(sheets.length + 1).padStart(2, "0")}.jpg`,
      t0: chunk[0],
      t1: Math.min(next ?? count, duration),
      tiles: chunk.map((t, j) => ({
        t,
        x: (j % COLS) * TILE_W,
        y: Math.floor(j / COLS) * TILE_H,
        w: TILE_W,
        h: TILE_H,
      })),
    });
  }
  return sheets;
}

export function gridLayout(n: number, cols: number, w: number, h: number): string {
  return Array.from({ length: n }, (_, i) => `${(i % cols) * w}_${Math.floor(i / cols) * h}`).join("|");
}

// The matrix the renderer decodes with, so stills and sheets match the video it shows. For an
// untagged source Chrome uses bt601 below 720 lines and bt709 from there up; ffmpeg alone would
// assume bt601 at every size (docs/spike.md).
export function colorMatrix({ colorSpace, height }: Pick<Probe, "colorSpace" | "height">): string {
  if (colorSpace === "smpte170m" || colorSpace === "bt470bg") return "bt601";
  if (colorSpace === "bt2020nc" || colorSpace === "bt2020c") return "bt2020";
  if (colorSpace === "bt709") return "bt709";
  return height < 720 ? "bt601" : "bt709";
}

export function frameFile(t: number): string {
  return `${String(t + 1).padStart(4, "0")}.jpg`;
}

export async function extractFrames(input: string, probe: Probe, dir: string): Promise<number> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const m = colorMatrix(probe);
  await run("ffmpeg", [
    ...["-hide_banner", "-v", "error", "-i", input, "-an"],
    ...["-vf", `fps=1,scale=1280:-2:in_color_matrix=${m}:out_color_matrix=${m}`],
    ...["-q:v", "3", join(dir, "%04d.jpg")],
  ]);
  return (await readdir(dir)).length;
}

async function montage(
  files: string[],
  cols: number,
  tile: { w: number; h: number },
  canvas: { w: number; h: number },
  out: string,
): Promise<void> {
  const scaled = files.map(
    (_, i) =>
      `[${i}:v]scale=${tile.w}:${tile.h}:force_original_aspect_ratio=decrease,` +
      `pad=${tile.w}:${tile.h}:(ow-iw)/2:(oh-ih)/2[v${i}]`,
  );
  const inputs = files.map((_, i) => `[v${i}]`).join("");
  const stack =
    files.length === 1
      ? `${inputs}null[s]`
      : `${inputs}xstack=inputs=${files.length}:layout=${gridLayout(files.length, cols, tile.w, tile.h)}[s]`;
  await run("ffmpeg", [
    ...["-hide_banner", "-v", "error", "-y"],
    ...files.flatMap((file) => ["-i", file]),
    ...["-filter_complex", `${scaled.join(";")};${stack};[s]pad=${canvas.w}:${canvas.h}:0:0[out]`],
    ...["-map", "[out]", "-frames:v", "1", "-q:v", "3", out],
  ]);
}

// Tiles carry no timestamp text (drawtext is missing from common ffmpeg builds); index.json has the times.
export async function writeSheets(
  framesDir: string,
  build: string,
  count: number,
  duration: number,
): Promise<SheetEntry[]> {
  await mkdir(join(build, "sheets"), { recursive: true });
  const sheets = planSheets(count, duration);
  for (const sheet of sheets) {
    await montage(
      sheet.tiles.map((tile) => join(framesDir, frameFile(tile.t))),
      COLS,
      { w: TILE_W, h: TILE_H },
      { w: COLS * TILE_W, h: 3 * TILE_H },
      join(build, sheet.file),
    );
  }
  return sheets;
}

export async function writeContact(framesDir: string, count: number, out: string): Promise<void> {
  const times = tileTimes(count, CONTACT_COLS * CONTACT_ROWS);
  await montage(
    times.map((t) => join(framesDir, frameFile(t))),
    CONTACT_COLS,
    { w: CONTACT_TILE_W, h: CONTACT_TILE_H },
    { w: CONTACT_COLS * CONTACT_TILE_W, h: CONTACT_ROWS * CONTACT_TILE_H },
    out,
  );
}
