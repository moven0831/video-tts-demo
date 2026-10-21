import { z } from "zod";
import { EditPlan } from "../schema/edit-plan.ts";
import { writeJson } from "../util/fs.ts";

const out = new URL("../schema/edit-plan.schema.json", import.meta.url);
await writeJson(out.pathname, z.toJSONSchema(EditPlan));
console.log(`wrote ${out.pathname}`);
