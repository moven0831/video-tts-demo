import { z } from "zod";
import { EditPlan } from "../schema/edit-plan.ts";
import { writeAtomic } from "../util/fs.ts";

const out = new URL("../schema/edit-plan.schema.json", import.meta.url);
await writeAtomic(out.pathname, `${JSON.stringify(z.toJSONSchema(EditPlan), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
