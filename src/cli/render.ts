import { render } from "../render/render.ts";
import { parseProjectArgs } from "../util/project.ts";

const { paths, values } = parseProjectArgs(process.argv.slice(2), {
  draft: { type: "boolean" },
});

await render(paths.hf, paths.render, values.draft === true);
console.log(`rendered ${paths.render}`);
