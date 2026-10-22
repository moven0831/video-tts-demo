import { access, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "../util/exec.ts";
import { parseProjectArgs, type ProjectPaths } from "../util/project.ts";

type Log = (line: string) => void;

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function listBuild(paths: ProjectPaths): Promise<string[]> {
  try {
    return await readdir(paths.build);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

// Stops a mistyped path from deleting an unrelated build/ or out/ directory.
async function assertProject(paths: ProjectPaths): Promise<void> {
  if (!(await exists(paths.input)) && !(await exists(paths.plan))) {
    throw new Error(
      `${paths.root} is not a project: it has neither input.mp4 nor edit-plan.json`,
    );
  }
}

// build/cache holds paid ElevenLabs and Claude outputs, so it survives unless asked for.
export async function cleanAll(
  paths: ProjectPaths,
  opts: { cache: boolean },
  log: Log = console.log,
): Promise<void> {
  await assertProject(paths);
  await rm(paths.out, { recursive: true, force: true });
  if (opts.cache) {
    await rm(paths.build, { recursive: true, force: true });
    log(`removed ${paths.build} and ${paths.out}, including the paid cache`);
    return;
  }
  const entries = (await listBuild(paths)).filter((f) => f !== basename(paths.cache));
  for (const entry of entries) await rm(join(paths.build, entry), { recursive: true, force: true });
  log(
    `removed everything in ${paths.build} except ${basename(paths.cache)}, and ${paths.out}; ` +
      `kept ${paths.cache} (pass --cache to delete it)`,
  );
}

// The rendered composition and the demo's stage hashes: the next demo run builds them again.
export async function cleanRender(paths: ProjectPaths, log: Log = console.log): Promise<void> {
  await assertProject(paths);
  await rm(paths.hf, { recursive: true, force: true });
  await rm(paths.render, { force: true });
  const hashes = (await listBuild(paths)).filter((f) => f.endsWith(".hash"));
  for (const file of hashes) await rm(join(paths.build, file));
  log(`removed ${paths.hf}, ${paths.render} and ${hashes.length} stage hashes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMain(async () => {
    const { paths, values } = parseProjectArgs(process.argv.slice(2), {
      all: { type: "boolean" },
      cache: { type: "boolean" },
    });

    if (values.all) await cleanAll(paths, { cache: values.cache === true });
    else await cleanRender(paths);
  });
}
