import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSheets } from "./images.ts";

const tile = (t: number, col: number, row: number) => ({
  t,
  x: col * 640,
  y: row * 360,
  w: 640,
  h: 360,
});

async function withSheets(index: unknown, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sheets-"));
  try {
    await writeFile(join(dir, "01.jpg"), "one");
    await writeFile(join(dir, "02.jpg"), "two");
    await writeFile(join(dir, "index.json"), JSON.stringify(index));
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("each sheet is a label followed by its image, ordered by start time", async () => {
  const index = [
    { file: "02.jpg", t0: 9, t1: 12, tiles: [tile(9, 0, 0), tile(10, 1, 0), tile(11, 0, 1)] },
    { file: "01.jpg", t0: 0, t1: 3, tiles: [tile(1, 1, 0), tile(0, 0, 0), tile(2, 2, 0)] },
  ];
  await withSheets(index, async (dir) => {
    const { content, sizes } = await loadSheets(dir);

    assert.deepEqual(
      content.map((block) => block.type),
      ["text", "image", "text", "image"],
    );
    assert.deepEqual(content[0], {
      type: "text",
      text: "Sheet 1: 0:00–0:03; tiles left-to-right, top-to-bottom at 0s, 1s, 2s; each tile is 640x360 px",
    });
    assert.deepEqual(content[2], {
      type: "text",
      text: "Sheet 2: 0:09–0:12; tiles left-to-right, top-to-bottom at 9s, 10s, 11s; each tile is 640x360 px",
    });
    assert.deepEqual(content[1], {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("one").toString("base64") },
    });
    assert.deepEqual(sizes, [
      { width: 1920, height: 360 },
      { width: 1280, height: 720 },
    ]);
  });
});

test("minutes show as m:ss", async () => {
  const index = [{ file: "01.jpg", t0: 65, t1: 74, tiles: [tile(65, 0, 0)] }];
  await withSheets(index, async (dir) => {
    const { content } = await loadSheets(dir);
    assert.deepEqual(content[0], {
      type: "text",
      text: "Sheet 1: 1:05–1:14; tiles left-to-right, top-to-bottom at 65s; each tile is 640x360 px",
    });
  });
});
