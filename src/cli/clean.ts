import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "../util/exec.ts";
import { parseProjectArgs, type projectPaths } from "../util/project.ts";

type Paths = ReturnType<typeof projectPaths>;

// build/cache holds paid ElevenLabs and Claude outputs, so it survives unless asked for.
export async function cleanAll(
  paths: Paths,
  opts: { cache: boolean },
  log: (line: string) => void = console.log,
): Promise<void> {
  await rm(paths.out, { recursive: true, force: true });
  if (opts.cache) {
    await rm(paths.build, { recursive: true, force: true });
    log(`removed ${paths.build} and ${paths.out}, including the paid cache`);
    return;
  }
  const entries = (await readdir(paths.build).catch(() => [])).filter((f) => f !== basename(paths.cache));
  for (const entry of entries) await rm(join(paths.build, entry), { recursive: true, force: true });
  log(`removed ${paths.build} and ${paths.out}; kept ${paths.cache} (pass --cache to delete it)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMain(async () => {
    const { paths, values } = parseProjectArgs(process.argv.slice(2), {
      all: { type: "boolean" },
      cache: { type: "boolean" },
    });

    if (values.all) {
      await cleanAll(paths, { cache: values.cache === true });
    } else {
      await rm(paths.hf, { recursive: true, force: true });
      await rm(paths.render, { force: true });
      const hashes = (await readdir(paths.build).catch(() => [])).filter((f) => f.endsWith(".hash"));
      for (const file of hashes) await rm(join(paths.build, file));
      console.log(`removed ${paths.hf}, ${paths.render} and ${hashes.length} stage hashes`);
    }
  });
}
