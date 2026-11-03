import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { DATA_ROOT, isMissing, writeAtomic } from "./storage";

export const catalogEvents = new EventEmitter();

export type CatalogDraft = {
  id: string;
  kind: "app" | "item";
  parentId: string;
  title: string;
  appPath: string;
  version: string;
  target: string;
  description: string;
  enabled: boolean;
};
export async function readDrafts(directory = DATA_ROOT): Promise<CatalogDraft[]> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, "catalog-drafts.json"), "utf8"));
    if (
      !Array.isArray(value) ||
      !value.every(
        (v) =>
          v &&
          typeof v === "object" &&
          ["id", "parentId", "title", "appPath", "version", "target", "description"].every(
            (key) => typeof v[key] === "string",
          ) &&
          ["app", "item"].includes(v.kind) &&
          typeof v.enabled === "boolean",
      )
    )
      throw new Error("新增条目目录格式无效，未覆盖。");
    return value;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
export async function addDraft(input: Omit<CatalogDraft, "id">, directory = DATA_ROOT): Promise<void> {
  if (!input.title.trim()) throw new Error("名称不能为空。");
  if (input.kind === "app" && (!path.isAbsolute(input.appPath) || !input.appPath.endsWith(".app")))
    throw new Error("请选择绝对路径的 .app 应用。");
  if (input.kind === "app") {
    const stat = await fs.stat(input.appPath);
    if (!stat.isDirectory()) throw new Error("应用路径必须是目录。");
  }
  const drafts = await readDrafts(directory);
  if (
    drafts.some(
      (v) =>
        v.kind === input.kind &&
        (input.kind === "app"
          ? v.appPath === input.appPath
          : v.parentId === input.parentId && v.title === input.title.trim()),
    )
  )
    throw new Error("该条目已存在。");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "catalog-drafts.json");
  if (drafts.length) await fs.copyFile(file, file + ".bak");
  await writeAtomic(
    file,
    JSON.stringify(
      [...drafts, { ...input, title: input.title.trim(), id: `draft-${randomUUID()}` }],
      null,
      2,
    ) + "\n",
  );
  catalogEvents.emit("changed");
}
