import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { projectPaths } from "../util/project.ts";
import { cleanAll, cleanRender } from "./clean.ts";

async function project(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await mkdir(p.cacheDir("voice"), { recursive: true });
  await mkdir(p.out, { recursive: true });
  await writeFile(p.input, "video");
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
  assert.match(lines.join("\n"), /everything in .*build except cache, and .*out; kept .*cache/);
});

test("--all --cache removes the cache too", async (t) => {
  const p = await project(t);
  await cleanAll(p, { cache: true }, () => {});
  await assert.rejects(access(p.build));
  await assert.rejects(access(p.out));
});

test("--all on a project that was never built does not fail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await writeFile(p.plan, "{}");
  await cleanAll(p, { cache: false }, () => {});
});

test("the default clean removes the render and hashes and never touches build/cache", async (t) => {
  const p = await project(t);
  await mkdir(p.hf, { recursive: true });
  await writeFile(p.render, "r");
  await writeFile(p.stageHash("probe"), "h");
  await writeFile(p.demoHash("mux"), "h");
  await cleanRender(p, () => {});
  assert.deepEqual((await readdir(p.build)).sort(), ["cache", "probe.json"]);
  await access(join(p.cacheDir("voice"), "a.mp3"));
  await access(p.final);
});

test("the default clean on a project that was never built does not fail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await writeFile(p.input, "video");
  const lines: string[] = [];
  await cleanRender(p, (l) => lines.push(l));
  assert.match(lines[0], /0 stage hashes/);
});

test("clean refuses a directory that is not a project and deletes nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = projectPaths(root);
  await mkdir(p.cacheDir("voice"), { recursive: true });
  await mkdir(p.out, { recursive: true });
  await writeFile(join(p.cacheDir("voice"), "a.mp3"), "precious");
  await assert.rejects(cleanAll(p, { cache: true }, () => {}), /is not a project/);
  await assert.rejects(cleanAll(p, { cache: false }, () => {}), /is not a project/);
  await assert.rejects(cleanRender(p, () => {}), /is not a project/);
  await access(join(p.cacheDir("voice"), "a.mp3"));
  await access(p.out);
});

test("clean refuses a root that does not exist", async () => {
  const p = projectPaths(join(tmpdir(), "clean-no-such-project"));
  await assert.rejects(cleanAll(p, { cache: true }, () => {}), /is not a project/);
});
