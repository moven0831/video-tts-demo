import { fileURLToPath } from "node:url";
import { runPipeline } from "../render/pipeline.ts";
import { runInherited, runMain } from "../util/exec.ts";
import { parseProjectArgs, type StageName } from "../util/project.ts";

await runMain(async () => {
  const { paths, values } = parseProjectArgs(process.argv.slice(2), {
    force: { type: "boolean" },
    draft: { type: "boolean" },
    yes: { type: "boolean" },
    plan: { type: "boolean" },
  });

  const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const cli = (stage: StageName) => fileURLToPath(new URL(`./${stage}.ts`, import.meta.url));

  await runPipeline(
    paths,
    {
      force: values.force === true,
      draft: values.draft === true,
      yes: values.yes === true,
      plan: values.plan === true,
    },
    (stage, args) => runInherited(tsx, [cli(stage), paths.root, ...args]),
  );
  console.log(`done: ${paths.final}`);
});
