import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectArgs } from "../util/project.ts";

const { paths, values } = parseProjectArgs(process.argv.slice(2), {
  all: { type: "boolean" },
});

if (values.all) {
  await rm(paths.build, { recursive: true, force: true });
  await rm(paths.out, { recursive: true, force: true });
  console.log(`removed ${paths.build} and ${paths.out}`);
} else {
  await rm(paths.hf, { recursive: true, force: true });
  await rm(paths.render, { force: true });
  const hashes = (await readdir(paths.build).catch(() => [])).filter((f) => f.endsWith(".hash"));
  for (const file of hashes) await rm(join(paths.build, file));
  console.log(`removed ${paths.hf}, ${paths.render} and ${hashes.length} stage hashes`);
}
