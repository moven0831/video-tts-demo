import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlan } from "./load.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "load-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { plan: join(dir, "edit-plan.json"), probe: join(dir, "probe.json") };
  await cp("test/fixtures/edit-plan.json", paths.plan);
  await cp("test/fixtures/probe.json", paths.probe);
  return paths;
}

test("loadPlan returns the plan, the probe and the warnings", async (t) => {
  const paths = await setup(t);
  const { plan, probe, warnings } = await loadPlan(paths);
  assert.equal(probe.width, plan.meta.source.width);
  assert.deepEqual(warnings, []);
});

test("loadPlan throws one error listing every validation error, prefixed with the plan path", async (t) => {
  const paths = await setup(t);
  const plan = JSON.parse(await readFile(paths.plan, "utf8"));
  plan.chapters[0].scenes[0].source.out = 99;
  plan.audio.sfx[0].scene = "nowhere";
  await writeFile(paths.plan, JSON.stringify(plan));
  await assert.rejects(loadPlan(paths), (err: Error) => {
    assert.ok(err.message.startsWith(`${paths.plan}:\n`), err.message);
    assert.match(err.message, /past the source duration/);
    assert.match(err.message, /no scene "nowhere"/);
    return true;
  });
});
