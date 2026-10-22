import { audioClipCount } from "../render/mux.ts";
import { render } from "../render/render.ts";
import { Timeline } from "../timeline/types.ts";
import { runMain } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths, values } = parseProjectArgs(process.argv.slice(2), {
    draft: { type: "boolean" },
  });

  const timeline = await readJson(paths.timeline, Timeline);
  await render(paths.hf, paths.render, values.draft === true, audioClipCount(timeline));
  console.log(`rendered ${paths.render}`);
});
