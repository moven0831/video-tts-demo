import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Probe } from "../schema/artifacts.ts";
import { EditPlan } from "../schema/edit-plan.ts";
import { validatePlan } from "../schema/validate.ts";
import { readJson } from "../util/fs.ts";
import { parseProjectArgs } from "../util/project.ts";

const CHARS_PER_SEC = 15;

export function checkPlan(planJson: unknown, probe: Probe): { ok: boolean; report: string } {
  const parsed = EditPlan.safeParse(planJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `error: ${issue.path.join(".")}: ${issue.message}`);
    return { ok: false, report: issues.join("\n") };
  }
  const plan = parsed.data;
  const { errors, warnings } = validatePlan(plan, probe);
  const rows = [["chapter", "scene", "source", "speech s", "fit"]];
  for (const chapter of plan.chapters) {
    for (const scene of chapter.scenes) {
      const chars = scene.narration.reduce((sum, line) => sum + line.text.length, 0);
      rows.push([
        chapter.id,
        scene.id,
        `${scene.source.in}-${scene.source.out}`,
        (chars / CHARS_PER_SEC).toFixed(1),
        scene.fit,
      ]);
    }
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  const table = rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  const report = [
    ...errors.map((e) => `error: ${e}`),
    ...warnings.map((w) => `warning: ${w}`),
    ...table,
  ].join("\n");
  return { ok: errors.length === 0, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { paths } = parseProjectArgs(process.argv.slice(2), {});
  const probe = await readJson(paths.probe, Probe);
  const { ok, report } = checkPlan(JSON.parse(await readFile(paths.plan, "utf8")), probe);
  console.log(report);
  process.exitCode = ok ? 0 : 1;
}
