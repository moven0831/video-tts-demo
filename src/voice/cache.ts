import { stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../util/fs.ts";

export function cachePath(dir: string, key: string, ext: string): string {
  return join(dir, `${key}.${ext}`);
}

export async function isCached(dir: string, key: string, ext: string): Promise<boolean> {
  try {
    await stat(cachePath(dir, key, ext));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function writeCached(
  dir: string,
  key: string,
  ext: string,
  produce: () => Promise<Buffer>,
): Promise<string> {
  const path = cachePath(dir, key, ext);
  if (await isCached(dir, key, ext)) return path;
  await writeAtomic(path, await produce());
  return path;
}
