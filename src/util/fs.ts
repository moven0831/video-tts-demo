import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

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
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${path}: ${err.message}`, { cause: err });
    throw err;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path}:\n${z.prettifyError(parsed.error)}`, { cause: parsed.error });
  }
  return parsed.data;
}
