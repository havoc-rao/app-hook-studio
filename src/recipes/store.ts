import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT, isMissing, writeAtomic, loadConfig } from "../core/storage";
import { sha256 } from "../core/hash";
import { PatchEngine } from "../core/engine";
import { APP_ADAPTERS } from "../apps/registry";
import { Recipe, recipeSchema } from "./schema";
import { recipeAdapter } from "./adapter";

export const recipeDirectory = (root = DATA_ROOT) => path.join(root, "recipes");
export const recipeRevision = (recipe: Recipe) => sha256(JSON.stringify(recipe));
export async function registeredRecipes(root = DATA_ROOT) {
  const directory = recipeDirectory(root);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return { recipes: [] as Recipe[], errors: [] as string[] };
    throw error;
  }
  const recipes: Recipe[] = [],
    errors: string[] = [];
  for (const name of names.sort().filter((n) => n.endsWith(".json"))) {
    try {
      const recipe = recipeSchema.parse(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
      if (name !== `${recipe.id}.json` || APP_ADAPTERS.some((a) => a.id === recipe.id))
        throw new Error("Recipe ID conflicts with file or built-in adapter");
      recipeAdapter(recipe);
      recipes.push(recipe);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { recipes, errors };
}
export async function getRecipe(id: string, root = DATA_ROOT): Promise<Recipe> {
  const loaded = await registeredRecipes(root);
  const recipe = loaded.recipes.find((r) => r.id === id);
  if (!recipe) throw new Error(`Registered recipe not found: ${id}. ${loaded.errors.join("; ")}`);
  return recipe;
}
export async function validateRecipe(input: unknown, root = DATA_ROOT) {
  const recipe = recipeSchema.parse(input);
  if (
    APP_ADAPTERS.some((a) => a.id === recipe.id) ||
    (await matchesPath(
      recipe.appPath,
      APP_ADAPTERS.map((a) => a.defaultAppPath),
    ))
  )
    throw new Error("Built-in App requires its existing driver; cannot shadow it with a DOM recipe.");
  const adapter = recipeAdapter(recipe);
  const directory = path.join(root, "apps", recipe.id);
  const config = await loadConfig(adapter, directory);
  const report = await new PatchEngine(adapter, directory).preflight(config);
  return { recipe, report };
}
export async function registerRecipe(input: unknown, expectedRevision?: string, root = DATA_ROOT) {
  const parsed = recipeSchema.parse(input),
    directory = recipeDirectory(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, ".registration.lock");
  const lock = await fs.open(lockFile, "wx", 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Registration busy (or interrupted writer). Retry; if no MCP writer remains, remove recipes/.registration.lock.",
      );
    throw error;
  });
  try {
    const file = path.join(directory, `${parsed.id}.json`);
    let previous: Recipe | undefined;
    try {
      previous = recipeSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (previous ? expectedRevision !== recipeRevision(previous) : expectedRevision !== undefined)
      throw new Error("Revision conflict. Read get_app and pass its current revision before updating.");
    const { recipe, report } = await validateRecipe(parsed, root);
    if (!report.compatible)
      throw new Error(report.checks.find((c) => c.status === "fail")?.detail ?? "Preflight failed");
    const existing = await registeredRecipes(root);
    if (
      await matchesPath(
        recipe.appPath,
        existing.recipes.filter((r) => r.id !== recipe.id).map((r) => r.appPath),
      )
    )
      throw new Error("An App path already has a registered recipe. Add items to that recipe instead.");
    if (previous)
      await fs.copyFile(file, path.join(directory, `${recipe.id}.${recipeRevision(previous)}.bak`));
    await writeAtomic(file, JSON.stringify(recipe, null, 2) + "\n");
    return {
      id: recipe.id,
      revision: recipeRevision(recipe),
      registered: true,
      installed: false,
      runtimeStatus: recipe.evidence.runtimeStatus,
      nextStep: "Refresh Raycast App list, configure features, then Install the whole App.",
      checks: report.checks,
    };
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

async function matchesPath(selected: string, candidates: string[]): Promise<boolean> {
  const real = await fs.realpath(selected);
  for (const candidate of candidates) {
    try {
      if ((await fs.realpath(candidate)) === real) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}
