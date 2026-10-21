import { z } from "zod";
import { EditPlan } from "../schema/edit-plan.ts";
import { runMain } from "../util/exec.ts";
import { writeJson } from "../util/fs.ts";

await runMain(async () => {
  const out = new URL("../schema/edit-plan.schema.json", import.meta.url);
  await writeJson(out.pathname, z.toJSONSchema(EditPlan));
  console.log(`wrote ${out.pathname}`);
});
