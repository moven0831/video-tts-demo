import { audioDuration } from "../probe/ffprobe.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { EXIT_NEEDS_SPEND } from "../util/exec.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";
import { createElevenLabs } from "../voice/elevenlabs.ts";
import { runAudition, runVoice } from "../voice/generate.ts";

const { paths, values } = parseProjectArgs(process.argv.slice(2), {
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  audition: { type: "string" },
  voices: { type: "string" },
});
const deps = { voice: createElevenLabs(), duration: audioDuration };
const log = (line: string) => console.log(line);
const yes = values.yes ?? false;

if (values.audition !== undefined) {
  if (!values.voices) throw new Error("--audition needs --voices id1,id2");
  await runAudition(deps, paths, {
    text: values.audition,
    voiceIds: values.voices.split(","),
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_v4",
    yes,
    log,
  });
} else {
  const plan = await readJson(paths.plan, EditPlan);
  const dryRun = values["dry-run"] ?? false;
  const manifest = await runVoice(plan, deps, paths, { yes, dryRun, log, env: process.env });
  if (!manifest && !dryRun) process.exitCode = EXIT_NEEDS_SPEND;
}
