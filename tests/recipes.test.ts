import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { recipeFixture } from "./recipe-fixture";
import { recipeAdapter } from "../src/recipes/adapter";
import {
  getRecipe,
  recipeRevision,
  registerRecipe,
  registeredRecipes,
  validateRecipe,
} from "../src/recipes/store";
import { PatchEngine } from "../src/core/engine";
import { defaultConfig } from "../src/core/contracts";
import { prepareAppInstall } from "../src/application/app-install";
import { saveConfig, loadConfig } from "../src/core/storage";

test("executable registration is metadata-only; whole App install honors enabled settings and restores exact bytes", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const second = { ...f.recipe.features[0], id: "new", title: "New", shortcut: "cmd+n", enabled: false };
  f.recipe.features.push(second);
  const validation = await validateRecipe(f.recipe, f.data);
  assert.equal(validation.report.compatible, true);
  await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
  const registered = await registerRecipe(f.recipe, undefined, f.data);
  assert.equal(registered.installed, false);
  assert.equal(await fs.readFile(f.resource, "utf8"), f.source);
  const adapter = recipeAdapter(await getRecipe(f.recipe.id, f.data));
  const directory = path.join(f.data, "apps", adapter.id);
  const config = defaultConfig(adapter);
  config.settings["stop.enabled"] = false;
  config.settings["new.enabled"] = true;
  await saveConfig(adapter, config, directory);
  const result = await (await prepareAppInstall(adapter, directory)).execute();
  assert.equal(result.complete, true);
  const engine = new PatchEngine(adapter, directory);
  assert.equal((await engine.inspect(f.recipe.appPath)).installedConfig?.settings["stop.enabled"], false);
  assert.equal((await engine.apply(config)).changed, false);
  const previousRecipe = await getRecipe(adapter.id, f.data);
  const metadataOnly = { ...previousRecipe, title: "Updated display title" };
  const metadataUpdate = await registerRecipe(metadataOnly, recipeRevision(previousRecipe), f.data);
  const changedAction = {
    ...metadataOnly,
    features: metadataOnly.features.map((feature, i) =>
      i === 0 ? { ...feature, action: "root.click();" } : feature,
    ),
  };
  await assert.rejects(
    registerRecipe(changedAction, metadataUpdate.revision, f.data),
    /Restore previous recipe/,
  );
  assert.equal((await getRecipe(adapter.id, f.data)).title, metadataOnly.title);
  await engine.restore(f.recipe.appPath);
  assert.equal(await fs.readFile(f.resource, "utf8"), f.source);
  const current = await getRecipe(adapter.id, f.data);
  const next = {
    ...current,
    features: [...current.features, { ...current.features[0], id: "third", shortcut: "cmd+shift+x" }],
  };
  await registerRecipe(next, recipeRevision(current), f.data);
  const retained = await loadConfig(recipeAdapter(next), directory);
  assert.equal(retained.settings["stop.enabled"], false);
  assert.equal(retained.settings["new.enabled"], true);
  assert.equal(retained.settings["third.enabled"], true);
});

test("registry requires revisions, preserves backups/settings, and rejects unknown resources/versions/traversal/modified patches", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const before = await registerRecipe(f.recipe, undefined, f.data);
  await assert.rejects(
    registerRecipe({ ...f.recipe, title: "Updated" }, undefined, f.data),
    /Revision conflict/,
  );
  const update = await registerRecipe({ ...f.recipe, title: "Updated" }, before.revision, f.data);
  assert.notEqual(update.revision, before.revision);
  assert.equal((await registeredRecipes(f.data)).recipes.length, 1);
  assert.ok((await fs.readdir(path.join(f.data, "recipes"))).some((name) => name.endsWith(".bak")));
  await fs.writeFile(f.resource, "unknown");
  assert.equal((await validateRecipe(f.recipe, f.data)).report.compatible, false);
  await fs.writeFile(f.resource, f.source);
  await fs.writeFile(path.join(f.recipe.appPath, "Contents/package.json"), '{"version":"2.0"}');
  assert.equal((await validateRecipe(f.recipe, f.data)).report.compatible, false);
  assert.throws(() =>
    recipeAdapter({
      ...f.recipe,
      profile: { ...f.recipe.profile, resource: { ...f.recipe.profile.resource, path: "../outside.js" } },
    }),
  );
  const adapter = recipeAdapter(f.recipe),
    patched = adapter.patch(
      f.source,
      adapter.defaultSettings,
      await Promise.resolve({ id: "x", label: "x", artifactRelativePath: "x", originalSha256: "x" }),
    );
  assert.throws(() => adapter.analyze(patched + "/* altered */", {} as never), /Modified patch/);
  assert.equal(recipeRevision(await getRecipe(f.recipe.id, f.data)), update.revision);
});

test("registered action runs in target DOM only; disabled actions, duplicates, IME, repeat and wrong scope do not fire", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const adapter = recipeAdapter(f.recipe);
  const patched = adapter.patch(f.source, adapter.defaultSettings, {} as never);
  let listener: (event: Record<string, unknown>) => Promise<void> = async () => {};
  let registrations = 0;
  const target = {};
  const context = vm.createContext({
    document: {
      querySelector: () => ({ contains: (value: unknown) => value === target, getClientRects: () => [{}] }),
      addEventListener: (event: string, fn: typeof listener) => {
        if (event === "keydown") {
          listener = fn;
          registrations++;
        }
      },
    },
    console,
  });
  vm.runInContext(patched, context);
  vm.runInContext(patched, context);
  assert.equal(registrations, 1);
  assert.equal(context.actionRuns, undefined);
  const event = (overrides = {}) => ({
    target,
    code: "KeyS",
    key: "s",
    metaKey: true,
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  });
  await listener(event({ repeat: true }));
  await listener(event({ isComposing: true }));
  await listener(event({ target: {} }));
  assert.equal(context.actionRuns, undefined);
  await listener(event());
  assert.equal(context.actionRuns, 1);
  const disabled = adapter.patch(
    f.source,
    { ...adapter.defaultSettings, "stop.enabled": false },
    {} as never,
  );
  const disabledContext = vm.createContext({
    document: {
      querySelector: () => ({ contains: () => true, getClientRects: () => [{}] }),
      addEventListener: (_: string, fn: typeof listener) => {
        listener = fn;
      },
    },
    console,
  });
  vm.runInContext(disabled, disabledContext);
  await listener(event());
  assert.equal(disabledContext.actionRuns, undefined);
});

test("package symlink escapes and ambiguous mounts are rejected, and failed registration retains the prior recipe", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const registered = await registerRecipe(f.recipe, undefined, f.data);
  const badMount = {
    ...f.recipe,
    profile: { ...f.recipe.profile, mount: { ...f.recipe.profile.mount, anchor: "missing anchor" } },
  };
  await assert.rejects(registerRecipe(badMount, registered.revision, f.data), /anchor/);
  assert.equal(recipeRevision(await getRecipe(f.recipe.id, f.data)), registered.revision);
  const outside = path.join(f.root, "outside.js");
  await fs.writeFile(outside, f.source);
  await fs.unlink(f.resource);
  await fs.symlink(outside, f.resource);
  const validation = await validateRecipe(f.recipe, f.data);
  assert.equal(validation.report.compatible, false);
  assert.match(validation.report.checks.find((check) => check.status === "fail")!.detail, /escapes/);
  await fs.writeFile(path.join(f.data, "recipes", "broken.json"), "{}");
  const loaded = await registeredRecipes(f.data);
  assert.equal(loaded.recipes.length, 1);
  assert.equal(loaded.errors.length, 1);
});

test("double Escape honors interval, focus resets and first press passthrough", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  f.recipe.features[0].trigger = "double-escape";
  let listener: (event: object) => Promise<void> = async () => {},
    reset = () => {},
    time = 0,
    consumed = 0;
  const target = {};
  const context = vm.createContext({
    document: {
      querySelector: () => ({ contains: () => true, getClientRects: () => [{}] }),
      addEventListener: (kind: string, fn: never) => {
        if (kind === "keydown") listener = fn;
        else reset = fn;
      },
    },
    performance: { now: () => time },
    console,
  });
  const adapter = recipeAdapter(f.recipe);
  vm.runInContext(adapter.patch(f.source, adapter.defaultSettings, {} as never), context);
  const event = (overrides = {}) => ({
    target,
    code: "Escape",
    key: "Escape",
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      consumed++;
    },
    stopPropagation() {},
    ...overrides,
  });
  await listener(event());
  assert.equal(consumed, 0);
  time = 100;
  await listener(event({ repeat: true }));
  assert.equal(context.actionRuns, undefined);
  time = 200;
  await listener(event());
  assert.equal(context.actionRuns, 1);
  assert.equal(consumed, 1);
  await listener(event());
  reset();
  time = 250;
  await listener(event());
  assert.equal(context.actionRuns, 1);
  time = 1000;
  await listener(event());
  assert.equal(context.actionRuns, 1);
  await listener(event({ isComposing: true }));
  time = 1100;
  await listener(event());
  assert.equal(context.actionRuns, 1);
});
