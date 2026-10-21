import { basename, join, resolve } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export type CacheKind = "plan" | "voice" | "sfx" | "music";

export function projectPaths(arg: string) {
  const root = resolve(arg.includes("/") ? arg : join("projects", arg));
  const build = join(root, "build");
  const out = join(root, "out");
  return {
    root,
    name: basename(root),
    input: join(root, "input.mp4"),
    brief: join(root, "brief.md"),
    plan: join(root, "edit-plan.json"),
    music: join(root, "music"),
    build,
    probe: join(build, "probe.json"),
    scenes: join(build, "scenes.json"),
    motion: join(build, "motion.json"),
    frames: join(build, "frames"),
    sheets: join(build, "sheets"),
    contact: join(build, "contact.jpg"),
    cache: join(build, "cache"),
    voice: join(build, "voice.json"),
    timeline: join(build, "timeline.json"),
    captionsSrt: join(build, "captions.srt"),
    captionsVtt: join(build, "captions.vtt"),
    hf: join(build, "hf"),
    render: join(build, "render.mp4"),
    out,
    final: join(out, "final.mp4"),
    finalSrt: join(out, "final.srt"),
    finalVtt: join(out, "final.vtt"),
    finalContact: join(out, "contact.jpg"),
    stageHash: (stage: string) => join(build, `${stage}.hash`),
    demoHash: (stage: string) => join(build, `${stage}.demo.hash`),
    cacheDir: (kind: CacheKind) => join(build, "cache", kind),
  };
}

export function parseProjectArgs<const O extends ParseArgsOptionsConfig>(
  argv: string[],
  options: O,
) {
  const { positionals, values } = parseArgs({ args: argv, options, allowPositionals: true });
  if (positionals.length !== 1) {
    throw new Error(`expected one project name or path, got ${positionals.length}`);
  }
  return { paths: projectPaths(positionals[0]), values };
}
