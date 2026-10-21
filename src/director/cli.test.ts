import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../cli/plan-check.ts";
import { runPlan } from "../cli/plan.ts";
import type { Probe } from "../schema/artifacts.ts";
import { projectPaths } from "../util/project.ts";
import type { PlanClient } from "./plan.ts";

const fixture = JSON.parse(readFileSync("test/fixtures/edit-plan.json", "utf8"));
const probe: Probe = JSON.parse(readFileSync("test/fixtures/probe.json", "utf8"));
const { source: _source, ...meta } = fixture.meta;

function fakeClient() {
  const calls: unknown[] = [];
  const client: PlanClient = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            finalMessage: async () => ({
              stop_reason: "end_turn",
              stop_details: null,
              content: [{ type: "text", text: JSON.stringify({ ...fixture, meta }) }],
              usage: { input_tokens: 10, output_tokens: 20 },
            }),
          };
        },
      },
    },
  };
  return { client, calls };
}

async function withProject(run: (paths: ReturnType<typeof projectPaths>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "proj-"));
  try {
    const paths = projectPaths(root);
    await mkdir(paths.sheets, { recursive: true });
    await cp("test/fixtures/probe.json", paths.probe);
    await writeFile(paths.scenes, "[]");
    await writeFile(paths.motion, JSON.stringify({ boxes: [], idle: [] }));
    await writeFile(join(paths.sheets, "01.jpg"), "jpeg");
    const tiles = [{ t: 0, x: 0, y: 0, w: 640, h: 360 }];
    await writeFile(
      join(paths.sheets, "index.json"),
      JSON.stringify([{ file: "01.jpg", t0: 0, t1: 3, tiles }]),
    );
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("plan without --yes prints an estimate and calls nothing", async () => {
  await withProject(async (paths) => {
    const { client, calls } = fakeClient();
    const lines: string[] = [];
    await runPlan(paths, client, { yes: false, force: false }, (l) => lines.push(l));
    assert.equal(calls.length, 0);
    assert.match(lines.join("\n"), /1 sheets, about \d+ input tokens/);
    assert.match(lines.join("\n"), /estimated cost \$\d/);
    await assert.rejects(readFile(paths.plan));
  });
});

test("plan --yes writes edit-plan.json", async () => {
  await withProject(async (paths) => {
    await runPlan(paths, fakeClient().client, { yes: true, force: false }, () => {});
    assert.deepEqual(JSON.parse(await readFile(paths.plan, "utf8")), fixture);
  });
});

test("plan refuses to overwrite an existing edit-plan.json without --force", async () => {
  await withProject(async (paths) => {
    await writeFile(paths.plan, "hand edits");
    const { client, calls } = fakeClient();
    await assert.rejects(runPlan(paths, client, { yes: true, force: false }, () => {}), /--force/);
    assert.equal(calls.length, 0);
    assert.equal(await readFile(paths.plan, "utf8"), "hand edits");

    await runPlan(paths, client, { yes: true, force: true }, () => {});
    assert.deepEqual(JSON.parse(await readFile(paths.plan, "utf8")), fixture);
  });
});

test("plan names the probe command when inputs are missing", async () => {
  await withProject(async (paths) => {
    await rm(paths.motion);
    await assert.rejects(
      runPlan(paths, fakeClient().client, { yes: true, force: false }, () => {}),
      /npm run probe -- /,
    );
  });
});

test("checkPlan passes the fixture and lists each scene", () => {
  const { ok, report } = checkPlan(fixture, probe);
  assert.equal(ok, true);
  assert.match(report, /chapter\s+scene\s+source\s+speech s\s+fit/);
  assert.match(report, /getting-started\s+\S+\s+\d/);
});

test("checkPlan fails on schema errors with their paths", () => {
  const broken = structuredClone(fixture);
  broken.chapters[0].scenes[0].fit = "wobble";
  const { ok, report } = checkPlan(broken, probe);
  assert.equal(ok, false);
  assert.match(report, /error: chapters\.0\.scenes\.0\.fit/);
});

test("checkPlan fails on validation errors", () => {
  const broken = structuredClone(fixture);
  broken.chapters[0].scenes[0].source.out = 99;
  const { ok, report } = checkPlan(broken, probe);
  assert.equal(ok, false);
  assert.match(report, /error: .*past the source duration 8/);
});
