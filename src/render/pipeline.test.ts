import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { projectPaths } from "../util/project.ts";
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

// Writes each stage's outputs the way the real CLIs would.
function fakeExec(p: ReturnType<typeof projectPaths>, calls: string[]) {
  return async (stage: string, args: string[]) => {
    calls.push([stage, ...args].join(" "));
    const outputs: Record<string, string[]> = {
      probe: [p.probe],
      voice: [p.voice],
      timeline: [p.timeline, p.captionsSrt, p.captionsVtt],
      compose: [join(p.hf, "index.html")],
      render: [p.render],
      mux: [p.final, p.finalSrt, p.finalVtt, p.finalContact],
    };
    for (const file of outputs[stage] ?? []) {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, `${stage}-${calls.length}`);
    }
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
  assert.deepEqual(calls, []);
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
  assert.equal(calls[0], "plan-check");
  assert.equal(calls.length, 6);
});

test("changing quality reruns render and mux only", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  await runPipeline(p, OPTS, fakeExec(p, calls));
  calls.length = 0;
  await runPipeline(p, { ...OPTS, draft: false }, fakeExec(p, calls));
  assert.deepEqual(calls, ["render", "mux"]);
});

test("a missing plan stops the demo unless --plan is given", async (t) => {
  const p = await project(t);
  await rm(p.plan);
  await assert.rejects(runPipeline(p, OPTS, fakeExec(p, [])), /--plan/);
  const calls: string[] = [];
  const exec = fakeExec(p, calls);
  await runPipeline(p, { ...OPTS, plan: true }, async (stage, args) => {
    await exec(stage, args);
    if (stage === "plan") await writeFile(p.plan, "{}");
  });
  assert.deepEqual(calls.slice(0, 3), ["probe", "plan --yes", "plan-check"]);
});

test("without --yes the demo stops when voice has not been generated", async (t) => {
  const p = await project(t);
  const calls: string[] = [];
  const exec = fakeExec(p, calls);
  await assert.rejects(
    runPipeline(p, { ...OPTS, yes: false }, async (stage, args) => {
      if (stage !== "voice") return exec(stage, args);
      calls.push("voice");
    }),
    /rerun with --yes/,
  );
  assert.deepEqual(calls, ["probe", "plan-check", "voice"]);
});

test("without --yes a voice.json older than the plan also stops the demo", async (t) => {
  const p = await project(t);
  await writeFile(p.voice, "old");
  await utimes(p.voice, new Date(1000), new Date(1000));
  const exec = fakeExec(p, []);
  await assert.rejects(
    runPipeline(p, { ...OPTS, yes: false }, (stage, args) =>
      stage === "voice" ? Promise.resolve() : exec(stage, args),
    ),
    /rerun with --yes/,
  );
});

test("treeHash changes with file content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.html"), "a");
  const first = await treeHash(dir);
  await writeFile(join(dir, "index.html"), "b");
  assert.notEqual(await treeHash(dir), first);
});
