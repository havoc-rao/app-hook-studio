import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Ajv from "ajv";
import { sha256 } from "../src/core/hash";
import { recipeFixture } from "./recipe-fixture";

test("real stdio MCP client discovers tools, validates/registers executable Apps/items, and preflights without target writes", async (t) => {
  const f = await recipeFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp.cjs"), "--data-root", f.data],
    stderr: "pipe",
  });
  const client = new Client({ name: "app-hook-test", version: "1.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "get_app",
    "get_recipe_schema",
    "list_apps",
    "list_pending_approvals",
    "preflight_app",
    "register_app",
    "register_items",
    "respond_to_approval",
    "validate_recipe",
  ]);
  const ajv = new Ajv({ strict: false });
  for (const tool of tools.tools) {
    ajv.compile(tool.inputSchema);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(
      tool.annotations?.readOnlyHint,
      !tool.name.startsWith("register_") && tool.name !== "respond_to_approval",
    );
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(Array.isArray(response.content));
    const value = JSON.parse((response.content as { text: string }[])[0].text);
    return { response, value };
  };
  const built = (await call("get_app", { appId: "codebuddy-cn" })).value;
  assert.ok(built.features.some((f: { id: string }) => f.id === "approval-notification"));
  const builtList = (await call("list_apps")).value.apps.find((a: { id: string }) => a.id === "codebuddy-cn");
  assert.ok(builtList.items.some((f: { id: string }) => f.id === "approval-notification"));
  assert.ok(built.features.some((f: { id: string }) => f.id === "approval-control"));
  assert.equal(
    (await call("respond_to_approval", { requestId: "stale", action: "allow" })).response.isError,
    true,
  );
  const schema = (await call("get_recipe_schema")).value.schema;
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.properties.schemaVersion.const, 2);
  const validRecipe = ajv.compile(schema);
  assert.equal(validRecipe(f.recipe), true);
  assert.equal(validRecipe({ ...f.recipe, schemaVersion: 1 }), false);
  const example = JSON.parse(await fs.readFile("docs/recipes/example.recipe.json", "utf8"));
  assert.equal(validRecipe(example), true);
  assert.equal(example.profile.resource.sha256, sha256(await fs.readFile("docs/recipes/example-main.js")));
  const file = path.join(f.root, "recipe.json");
  await fs.writeFile(file, JSON.stringify(f.recipe));
  assert.equal((await call("validate_recipe", { recipePath: file })).value.compatible, true);
  await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
  const registered = (await call("register_app", { recipePath: file })).value;
  assert.equal(registered.installed, false);
  assert.equal(
    (await call("list_apps")).value.apps.some((app: { id: string }) => app.id === f.recipe.id),
    true,
  );
  const app = (await call("get_app", { appId: f.recipe.id })).value;
  assert.equal(app.revision, registered.revision);
  const itemsFile = path.join(f.root, "items.json");
  await fs.writeFile(itemsFile, JSON.stringify([{ ...f.recipe.features[0], id: "new", shortcut: "cmd+n" }]));
  const updated = (
    await call("register_items", { appId: f.recipe.id, itemsPath: itemsFile, expectedRevision: app.revision })
  ).value;
  assert.equal(updated.registered, true);
  assert.equal((await call("get_app", { appId: f.recipe.id })).value.recipe.features.length, 2);
  const plan = (await call("preflight_app", { appId: f.recipe.id })).value;
  assert.equal(plan.items.length, 2);
  assert.equal(plan.restartRequired, true);
  const conflict = await call("register_items", {
    appId: f.recipe.id,
    itemsPath: itemsFile,
    expectedRevision: app.revision,
  });
  assert.equal(conflict.response.isError, true);
  assert.match(conflict.value.error, /Revision conflict/);
  assert.equal(await fs.readFile(f.resource, "utf8"), f.source);
  await assert.rejects(fs.stat(path.join(f.data, "apps")), { code: "ENOENT" });
});
