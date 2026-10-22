import { rename, rm, stat } from "node:fs/promises";
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

// `check` sees the data staged under another name, so a bad clip never takes the cache slot.
export async function writeCached(
  dir: string,
  key: string,
  ext: string,
  produce: () => Promise<Buffer>,
  check?: (staged: string) => Promise<void>,
): Promise<string> {
  const path = cachePath(dir, key, ext);
  if (await isCached(dir, key, ext)) return path;
  const data = await produce();
  if (!check) {
    await writeAtomic(path, data);
    return path;
  }
  const staged = cachePath(dir, key, `check.${ext}`);
  await writeAtomic(staged, data);
  try {
    await check(staged);
  } catch (err) {
    await rm(staged, { force: true });
    throw err;
  }
  await rename(staged, path);
  return path;
}
