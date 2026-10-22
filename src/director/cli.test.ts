import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkPlan } from "../cli/plan-check.ts";
import { runProbe } from "../probe/run.ts";
import { runPlan, runPlanFromNarration } from "../cli/plan.ts";
import type { Probe } from "../schema/artifacts.ts";
import { capture, EXIT_NEEDS_SPEND } from "../util/exec.ts";
import { projectPaths } from "../util/project.ts";
import { estimateCost, estimateRequest, type PlanClient } from "./plan.ts";

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
      JSON.stringify([{ file: "sheets/01.jpg", t0: 0, t1: 3, tiles }]),
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
    const outcome = await runPlan(paths, client, { yes: false, force: false }, (l) => lines.push(l));
    assert.equal(outcome, "needs-spend");
    assert.equal(calls.length, 0);
    assert.match(lines.join("\n"), /1 sheets, about \d+ input tokens/);
    assert.match(lines.join("\n"), /estimated cost \$\d/);
    await assert.rejects(readFile(paths.plan));
  });
});

test("the estimate says when there is no brief.md", async () => {
  await withProject(async (paths) => {
    const lines: string[] = [];
    await runPlan(paths, fakeClient().client, { yes: false, force: false }, (l) => lines.push(l));
    assert.ok(lines.includes("no brief.md; the director gets no brief"), lines.join("\n"));

    await writeFile(paths.brief, "Short and friendly.");
    lines.length = 0;
    await runPlan(paths, fakeClient().client, { yes: false, force: false }, (l) => lines.push(l));
    assert.ok(!lines.some((l) => l.includes("no brief.md")));
  });
});

test("a cached plan is written without --yes and without a client call", async () => {
  await withProject(async (paths) => {
    await runPlan(paths, fakeClient().client, { yes: true, force: false }, () => {});
    await rm(paths.plan);

    const second = fakeClient();
    const lines: string[] = [];
    const outcome = await runPlan(paths, second.client, { yes: false, force: false }, (l) => lines.push(l));
    assert.equal(outcome, "written");
    assert.equal(second.calls.length, 0);
    assert.deepEqual(JSON.parse(await readFile(paths.plan, "utf8")), fixture);
    assert.ok(lines.includes("plan came from the cache"));
  });
});

test("the estimate counts image tiles, text and the output range exactly", () => {
  const params = {
    model: "m",
    max_tokens: 1,
    system: "abcd",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(96) }] }],
  };
  const est = estimateRequest(params, [
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
  ]);
  // 23x13 and 46x26 tiles of 28 px, plus (96 + 4) characters at 4 per token
  assert.equal(est.images, 2);
  assert.equal(est.inputTokens, 299 + 1196 + 25);
  assert.ok(Math.abs(est.low - (1520 * 4 + 8000 * 20) / 1e6) < 1e-9);
  assert.ok(Math.abs(est.high - (1520 * 4 + 40000 * 20) / 1e6) < 1e-9);
  assert.ok(Math.abs(estimateCost(1000, 2000) - 0.044) < 1e-9);
});

test("src/cli/plan.ts without --yes exits 3, prints the estimate and writes nothing", async () => {
  await withProject(async (paths) => {
    const { code, stdout } = await capture(join("node_modules", ".bin", "tsx"), ["src/cli/plan.ts", paths.root], {
      env: { ANTHROPIC_API_KEY: "" },
    });
    assert.equal(code, EXIT_NEEDS_SPEND);
    assert.match(stdout, /1 sheets, about \d+ input tokens/);
    assert.match(stdout, /rerun with --yes to spend/);
    await assert.rejects(readFile(paths.plan));
  });
});

test("plan --yes writes edit-plan.json", async () => {
  await withProject(async (paths) => {
    const outcome = await runPlan(paths, fakeClient().client, { yes: true, force: false }, () => {});
    assert.equal(outcome, "written");
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

async function withNamedProject(run: (paths: ReturnType<typeof projectPaths>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "proj-"));
  try {
    const paths = projectPaths(join(root, "demo"));
    await mkdir(paths.build, { recursive: true });
    await cp("test/fixtures/probe.json", paths.probe);
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("plan --from-narration seeds a valid plan without the API", async () => {
  await withNamedProject(async (paths) => {
    const text = "# 0:00\nWelcome to the tour.\n\n# 0:04\nThat is all.";
    await runPlanFromNarration(paths, text, { force: false }, () => {});
    const written = JSON.parse(await readFile(paths.plan, "utf8"));
    assert.equal(written.meta.title, "Demo");
    assert.equal(written.chapters[0].title, "Walkthrough");
    assert.deepEqual(
      written.chapters[0].scenes.map((s: { source: { in: number; out: number } }) => [s.source.in, s.source.out]),
      [[0, 4], [4, 8]],
    );
    assert.equal(checkPlan(written, probe).ok, true);
  });
});

test("plan --from-narration slugifies the project name for meta.project", async () => {
  for (const [dir, slug] of [["My_Cool Demo", "my-cool-demo"], ["Café--Tour", "caf-tour"], ["!!!", "demo"]]) {
    const root = await mkdtemp(join(tmpdir(), "proj-"));
    try {
      const paths = projectPaths(join(root, dir));
      await mkdir(paths.build, { recursive: true });
      await cp("test/fixtures/probe.json", paths.probe);
      await runPlanFromNarration(paths, "One.", { force: false }, () => {});
      const written = JSON.parse(await readFile(paths.plan, "utf8"));
      assert.equal(written.meta.project, slug, dir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("plan --from-narration titles the plan from the project name, or Demo when it has no words", async () => {
  for (const [dir, title] of [["my_cool-demo", "My cool demo"], ["__", "Demo"], ["-", "Demo"]]) {
    const root = await mkdtemp(join(tmpdir(), "proj-"));
    try {
      const paths = projectPaths(join(root, dir));
      await mkdir(paths.build, { recursive: true });
      await cp("test/fixtures/probe.json", paths.probe);
      await runPlanFromNarration(paths, "One.", { force: false }, () => {});
      const written = JSON.parse(await readFile(paths.plan, "utf8"));
      assert.equal(written.meta.title, title, dir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("plan --from-narration keeps hand edits without --force and needs the probe", async () => {
  await withNamedProject(async (paths) => {
    await writeFile(paths.plan, "hand edits");
    await assert.rejects(runPlanFromNarration(paths, "One.", { force: false }, () => {}), /--force/);
    assert.equal(await readFile(paths.plan, "utf8"), "hand edits");
    await runPlanFromNarration(paths, "One.", { force: true }, () => {});
    assert.equal(JSON.parse(await readFile(paths.plan, "utf8")).meta.title, "Demo");
    await rm(paths.probe);
    await assert.rejects(runPlanFromNarration(paths, "One.", { force: true }, () => {}), /npm run probe/);
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
  assert.match(report, /^error: edit-plan\.json:\n/);
  assert.match(report, /chapters\[0\]\.scenes\[0\]\.fit/);
});

test("checkPlan fails on validation errors", () => {
  const broken = structuredClone(fixture);
  broken.chapters[0].scenes[0].source.out = 99;
  const { ok, report } = checkPlan(broken, probe);
  assert.equal(ok, false);
  assert.match(report, /error: .*past the source duration 8/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test(
  "plan dry-run reads what the real probe writes",
  { skip: hasFfmpeg ? false : "ffmpeg is not installed" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "proj-"));
    try {
      const paths = projectPaths(join(root, "demo"));
      await mkdir(paths.root, { recursive: true });
      const ff = spawnSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=3",
        "-pix_fmt", "yuv420p", paths.input,
      ]);
      assert.equal(ff.status, 0, String(ff.stderr));
      await runProbe(paths, { force: false });

      const { client, calls } = fakeClient();
      const lines: string[] = [];
      await runPlan(paths, client, { yes: false, force: false }, (l) => lines.push(l));
      assert.equal(calls.length, 0);
      assert.match(lines.join("\n"), /\d+ sheets, about \d+ input tokens/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
