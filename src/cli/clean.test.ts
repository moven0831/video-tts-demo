import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { projectPaths } from "../util/project.ts";
import { cleanAll } from "./clean.ts";

async function project(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await mkdir(p.cacheDir("voice"), { recursive: true });
  await mkdir(p.out, { recursive: true });
  await writeFile(join(p.cacheDir("voice"), "a.mp3"), "paid");
  await writeFile(p.probe, "{}");
  await writeFile(p.final, "video");
  return p;
}

test("--all keeps build/cache and says so", async (t) => {
  const p = await project(t);
  const lines: string[] = [];
  await cleanAll(p, { cache: false }, (l) => lines.push(l));
  assert.deepEqual(await readdir(p.build), ["cache"]);
  await access(join(p.cacheDir("voice"), "a.mp3"));
  await assert.rejects(access(p.out));
  assert.match(lines.join("\n"), /kept .*cache/);
});

test("--all --cache removes the cache too", async (t) => {
  const p = await project(t);
  await cleanAll(p, { cache: true }, () => {});
  await assert.rejects(access(p.build));
  await assert.rejects(access(p.out));
});

test("--all on a project that was never built does not fail", async (t) => {
  const p = projectPaths(await mkdtemp(join(tmpdir(), "clean-")));
  t.after(() => rm(p.root, { recursive: true, force: true }));
  await cleanAll(p, { cache: false }, () => {});
});
