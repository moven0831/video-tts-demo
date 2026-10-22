import { copyFile, mkdir } from "node:fs/promises";
import { contactSheet } from "../render/contact.ts";
import { audioClipCount, mux } from "../render/mux.ts";
import { Timeline } from "../timeline/types.ts";
import { runMain } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

await runMain(async () => {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});

  const timeline = await readJson(paths.timeline, Timeline);
  await mkdir(paths.out, { recursive: true });
  await mux(paths.render, paths.final, audioClipCount(timeline));
  await copyFile(paths.captionsSrt, paths.finalSrt);
  await copyFile(paths.captionsVtt, paths.finalVtt);
  await contactSheet(paths.final, paths.finalContact);
  console.log(`wrote ${paths.final}`);
});
