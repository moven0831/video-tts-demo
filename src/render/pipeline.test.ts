import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { EXIT_NEEDS_SPEND } from "../util/exec.ts";
import { projectPaths, type ProjectPaths, type StageName } from "../util/project.ts";
import { runPipeline, treeHash, type PipelineOptions } from "./pipeline.ts";

const OPTS: PipelineOptions = { force: false, draft: true, yes: true, plan: false };

async function project(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await mkdir(p.build, { recursive: true });
  await writeFile(p.input, "video");
  await writeFile(p.plan, "{}");
  return p;
}

const TIMELINE = {
  total: 1,
  stage: { width: 1920, height: 1080 },
  fit: { scale: 1, x: 0, y: 0 },
  segments: [],
  camera: [],
  clicks: [],
  callouts: [],
  cards: [],
  transitions: [],
  narration: [],
  captions: [],
  sfx: [],
};

// Writes a placeholder at every path the real stage writes.
function fakeExec(p: ProjectPaths, calls: string[], warnings: string[] = []) {
  return async (stage: StageName, args: string[]): Promise<number> => {
    calls.push([stage, ...args].join(" "));
    const outputs: Partial<Record<StageName, string[]>> = {
      probe: [p.probe],
      voice: [p.voice],
      timeline: [p.timeline, p.captionsSrt, p.captionsVtt],
      compose: [join(p.hf, "index.html")],
      render: [p.render],
      mux: [p.final, p.finalSrt, p.finalVtt, p.finalContact],
    };
    for (const file of outputs[stage] ?? []) {
      await mkdir(join(file, ".."), { recursive: true });
      const text =
        file === p.timeline ? JSON.stringify({ ...TIMELINE, warnings }) : `${stage}-${calls.length}`;
      await writeFile(file, text);
    }
    return 0;
  };
}

test("runs every stage in order, then skips them all when nothing changed", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.deepEqual(calls, [
    "probe",
    "plan-check",
    "voice --yes",
    "timeline",
    "compose",
    "render --draft",
    "mux",
  ]);
  calls.length = 0;
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.deepEqual(calls, ["probe", "plan-check", "voice --yes"]);
});

test("demo hashes only the stages it skips, in files probe never touches", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, []));
  const files = (await readdir(p.build)).filter((f) => f.endsWith(".hash")).sort();
  assert.deepEqual(files, ["compose", "mux", "render", "timeline"].map((s) => `${s}.demo.hash`));
});

test("--force reruns everything", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  calls.length = 0;
  await runPipeline(p, { ...OPTS, force: true }, fakeExec(p, calls));
  assert.equal(calls.length, 7);
});

test("changing the plan reruns plan-check onward", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  await writeFile(p.plan, '{"v":2}');
  calls.length = 0;
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.deepEqual(calls.slice(0, 5), ["probe", "plan-check", "voice --yes", "timeline", "compose"]);
});

test("changing quality reruns render and mux only", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  calls.length = 0;
  await runPipeline(p, { ...OPTS, draft: false }, fakeExec(p, calls));
  assert.deepEqual(calls, ["probe", "plan-check", "voice --yes", "render", "mux"]);
});

test("a render redone by hand makes the demo render again", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, []));
  await writeFile(p.render, "a manual draft render, different size");
  const calls: string[] = [];
  const log: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls), (line) => log.push(line));
  assert.deepEqual(calls.slice(-2), ["render --draft", "mux"]);
  assert.ok(log.includes("run render (build/render.mp4 changed since the stage wrote it)"), log.join("\n"));
  assert.ok(log.includes("skip compose (unchanged)"));
});

test("a deleted output makes its stage run again and says which", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, []));
  await rm(p.captionsVtt);
  const calls: string[] = [];
  const log: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls), (line) => log.push(line));
  assert.ok(calls.includes("timeline"));
  assert.ok(log.includes("run timeline (build/captions.vtt is missing)"), log.join("\n"));
});

test("a stage that exits 1 records no hash and drops the earlier one", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, []));
  await writeFile(p.plan, '{"v":2}');
  const exec = fakeExec(p, []);
  await assert.rejects(
    runPipeline(p, OPTS, async (stage, args) => (stage === "timeline" ? 1 : exec(stage, args))),
    /timeline exited with code 1/,
  );
  assert.ok(!(await readdir(p.build)).includes("timeline.demo.hash"));
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.ok(calls.includes("timeline"));
});

test("a stage that exits 0 without writing its outputs fails", async (t) => {
  const p = await project(t);
  const exec = fakeExec(p, []);
  await assert.rejects(
    runPipeline(p, OPTS, async (stage, args) => (stage === "timeline" ? 0 : exec(stage, args))),
    /timeline finished without writing build\/timeline.json/,
  );
});

test("a record in the old plain-hash format counts as no record", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, []));
  await writeFile(p.demoHash("mux"), "a".repeat(64));
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.deepEqual(calls.slice(-1), ["mux"]);
});

test("--plan with a plan already there is ignored and says so", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  const log: string[] = [];
  await runPipeline(p, { ...OPTS, plan: true }, fakeExec(p, calls), (line) => log.push(line));
  assert.ok(!calls.some((c) => c.startsWith("plan ")));
  assert.ok(
    log.includes("edit-plan.json exists; --plan ignored (use npm run plan -- <name> --force)"),
  );
});

test("timeline warnings print last, also when the timeline stage was skipped", async (t) => {
  const p = await project(t);
  await runPipeline(p, OPTS, fakeExec(p, [], ["music is 4.0 s but the video is 10.0 s"]));
  const log: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, []), (line) => log.push(line));
  assert.ok(log.includes("skip timeline (unchanged)"));
  assert.deepEqual(log.slice(-2), ["warnings:", "  music is 4.0 s but the video is 10.0 s"]);
});

test("no warnings, no warnings section", async (t) => {
  const p = await project(t);
  const log: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, []), (line) => log.push(line));
  assert.ok(!log.includes("warnings:"));
});

test("a missing plan stops the demo unless --plan is given", async (t) => {
  const p = await project(t);
  await rm(p.plan);
  await assert.rejects(runPipeline(p, OPTS, fakeExec(p, [])), /--plan/);
  const calls: string[] = [];
  const exec = fakeExec(p, calls);
  await runPipeline(p, { ...OPTS, plan: true }, async (stage, args) => {
    const code = await exec(stage, args);
    if (stage === "plan") await writeFile(p.plan, "{}");
    return code;
  });
  assert.deepEqual(calls.slice(0, 3), ["probe", "plan --yes", "plan-check"]);
});

test("--plan without --yes runs plan for its estimate and stops before spending", async (t) => {
  const p = await project(t);
  await rm(p.plan);
  const calls: string[] = [];
  const exec = fakeExec(p, calls);
  await assert.rejects(
    runPipeline(p, { ...OPTS, yes: false, plan: true }, async (stage, args) => {
      if (stage !== "plan") return exec(stage, args);
      calls.push(["plan", ...args].join(" "));
      return EXIT_NEEDS_SPEND;
    }),
    /plan needs to spend.*rerun with --yes/,
  );
  assert.deepEqual(calls, ["probe", "plan"]);
});

test("without --yes the demo stops when voice reports it needs to spend", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  const exec = fakeExec(p, calls);
  await assert.rejects(
    runPipeline(p, { ...OPTS, yes: false }, async (stage, args) => {
      if (stage !== "voice") return exec(stage, args);
      calls.push(["voice", ...args].join(" "));
      return EXIT_NEEDS_SPEND;
    }),
    /voice needs to spend.*rerun with --yes/,
  );
  assert.deepEqual(calls, ["probe", "plan-check", "voice"]);
});

test("without --yes the demo carries on when voice finds everything cached", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, { ...OPTS, yes: false }, fakeExec(p, calls));
  assert.deepEqual(calls.slice(0, 4), ["probe", "plan-check", "voice", "timeline"]);
});

test("any other non-zero exit fails the stage", async (t) => {
  const p = await project(t);
  await assert.rejects(
    runPipeline(p, OPTS, async (stage) => (stage === "plan-check" ? 1 : 0)),
    /plan-check exited with code 1/,
  );
});

test("the stored hash is the one computed before the stage ran", async (t) => {
  const p = await project(t);
  const exec = fakeExec(p, []);
  await runPipeline(p, OPTS, async (stage, args) => {
    const code = await exec(stage, args);
    if (stage === "timeline") await writeFile(p.plan, '{"edited":"mid-run"}');
    return code;
  });
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  assert.ok(calls.includes("timeline"), "timeline must rerun for the mid-run edit");
});

test("treeHash changes with file content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.html"), "a");
  const first = await treeHash(dir);
  await writeFile(join(dir, "index.html"), "b");
  assert.notEqual(await treeHash(dir), first);
});
