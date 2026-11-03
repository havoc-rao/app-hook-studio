import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { addDraft, readDrafts } from "../src/core/catalog";

test("draft catalog persists app and child items, backs up updates and preserves malformed data", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Example.app");
  await fs.mkdir(appPath);
  const input = {
    kind: "app" as const,
    parentId: "",
    title: "Example",
    appPath,
    version: "1.0",
    target: "",
    description: "",
    enabled: true,
  };
  await addDraft(input, root);
  const [app] = await readDrafts(root);
  await assert.rejects(addDraft(input, root), /已存在/);
  await addDraft({ ...input, kind: "item", parentId: app.id, title: "Stop" }, root);
  assert.equal((await readDrafts(root)).length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "catalog-drafts.json.bak"), "utf8")).length, 1);
  const file = path.join(root, "catalog-drafts.json");
  await fs.writeFile(file, "{}");
  await assert.rejects(addDraft({ ...input, title: "Other" }, root), /格式无效/);
  assert.equal(await fs.readFile(file, "utf8"), "{}");
});
