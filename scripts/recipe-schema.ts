import { z } from "zod";
import { promises as fs } from "node:fs";
import { recipeSchema } from "../src/recipes/schema";
async function main() {
  await fs.mkdir("docs/recipes", { recursive: true });
  await fs.writeFile(
    "docs/recipes/recipe-v2.schema.json",
    JSON.stringify(z.toJSONSchema(recipeSchema, { target: "draft-7" }), null, 2) + "\n",
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
