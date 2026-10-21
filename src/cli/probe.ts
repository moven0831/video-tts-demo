import { runProbe } from "../probe/run.ts";
import { parseProjectArgs } from "../util/project.ts";

const { paths, values } = parseProjectArgs(process.argv.slice(2), { force: { type: "boolean" } });
const result = await runProbe(paths, { force: values.force ?? false });
console.log(result === "skipped" ? `probe is up to date (${paths.build})` : `probed ${paths.input}`);
