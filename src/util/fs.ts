import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  try {
    await writeFile(part, data);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  await rename(part, path);
}

export function writeJson(path: string, value: unknown): Promise<void> {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}
