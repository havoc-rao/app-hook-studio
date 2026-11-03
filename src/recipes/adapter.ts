import { promises as fs } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { AppAdapter, Settings } from "../core/contracts";
import { parseShortcut } from "../core/shortcuts";
import { sha256 } from "../core/hash";
import { domRuntime } from "./dom-runtime";
import { Recipe, recipeSchema } from "./schema";

export function recipeAdapter(input: unknown): AppAdapter {
  const recipe = recipeSchema.parse(input);
  const codeHash = sha256(
    JSON.stringify({
      id: recipe.id,
      resource: recipe.profile.resource,
      mount: recipe.profile.mount,
      features: recipe.features.map(({ id, trigger, withinMs, action }) => ({
        id,
        trigger,
        withinMs,
        action,
      })),
    }),
  );
  const ids = recipe.features.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate feature IDs");
  const prefix = `/* APP_HOOK_RECIPE ${recipe.id} `,
    suffix = "/* APP_HOOK_RECIPE_END */";
  const defaults: Settings = Object.fromEntries(
    recipe.features.flatMap((f) => [
      [`${f.id}.enabled`, f.enabled],
      [`${f.id}.shortcut`, f.shortcut],
    ]),
  );
  const validate = (value: unknown): Settings => {
    if (!value || typeof value !== "object") throw new Error("Invalid recipe settings");
    const v = value as Settings,
      result: Settings = {},
      used = new Set<string>();
    for (const f of recipe.features) {
      const enabled = Object.hasOwn(v, `${f.id}.enabled`) ? v[`${f.id}.enabled`] : f.enabled,
        shortcut = Object.hasOwn(v, `${f.id}.shortcut`) ? v[`${f.id}.shortcut`] : f.shortcut;
      if (typeof enabled !== "boolean" || typeof shortcut !== "string")
        throw new Error(`Invalid settings: ${f.id}`);
      const parsed = parseShortcut(shortcut);
      if (f.trigger === "shortcut" && !parsed.meta && !parsed.ctrl && !parsed.alt)
        throw new Error("Shortcut requires Cmd/Ctrl/Option");
      const key = f.trigger === "double-escape" ? "double-escape" : JSON.stringify(parsed);
      if (enabled && used.has(key)) throw new Error("Enabled features have colliding triggers");
      if (enabled) used.add(key);
      result[`${f.id}.enabled`] = enabled;
      result[`${f.id}.shortcut`] = shortcut;
    }
    return result;
  };
  validate(defaults);
  for (const f of recipe.features) new Script(`(async function(event,root){${f.action}\n})`);
  const render = (settings: Settings) => {
    const actions = recipe.features.map((f) => `async function(event,root){${f.action}\n}`).join(",");
    const config = recipe.features.map((f) => ({
      enabled: settings[`${f.id}.enabled`],
      key: parseShortcut(String(settings[`${f.id}.shortcut`])),
      trigger: f.trigger,
      withinMs: f.withinMs,
    }));
    const metadata = Buffer.from(JSON.stringify({ recipeHash: codeHash, settings })).toString("base64");
    return `${prefix}${metadata} */\n${domRuntime(recipe.id, recipe.profile.mount.rootSelector, config, actions)}${suffix}\n`;
  };
  const insert = (original: string, hook: string) => {
    const anchor = recipe.profile.mount.anchor,
      first = original.indexOf(anchor);
    if (first < 0 || original.indexOf(anchor, first + anchor.length) !== -1)
      throw new Error("Mount anchor must match exactly once");
    const at = first + (recipe.profile.mount.placement === "after" ? anchor.length : 0);
    return original.slice(0, at) + hook + original.slice(at);
  };
  const analyze = (source: string) => {
    if (sha256(source) === recipe.profile.resource.sha256)
      return { kind: "original" as const, original: source };
    const start = source.indexOf(prefix),
      headerEnd = source.indexOf(" */\n", start),
      end = source.indexOf(suffix + "\n", headerEnd);
    if (start < 0 || headerEnd < 0 || end < 0 || source.indexOf(prefix, start + prefix.length) !== -1)
      throw new Error("Unknown or modified resource");
    const metadata = JSON.parse(
      Buffer.from(source.slice(start + prefix.length, headerEnd), "base64").toString("utf8"),
    );
    if (metadata.recipeHash !== codeHash)
      throw new Error(
        "Installed recipe differs. Restore previous recipe before changing its implementation/profile.",
      );
    const settings = validate(metadata.settings);
    const original = source.slice(0, start) + source.slice(end + suffix.length + 1);
    if (sha256(original) !== recipe.profile.resource.sha256 || insert(original, render(settings)) !== source)
      throw new Error("Modified patch; refusing overwrite");
    return { kind: "managed" as const, original, installedSettings: settings };
  };
  return {
    id: recipe.id,
    title: recipe.title,
    defaultAppPath: recipe.appPath,
    description: "Registered Recipe",
    supportDescription: `${recipe.profile.appVersion} · ${recipe.profile.id} · ${recipe.evidence.runtimeStatus}`,
    versions: {
      supported: {
        app: recipe.profile.appVersion,
        components: Object.fromEntries(recipe.profile.assertions.map((a) => [a.file + a.pointer, a.equals])),
      },
      async read(appPath) {
        return {
          app: String(await readAssertion(appPath, recipe.profile.assertions[0])),
          components: Object.fromEntries(
            await Promise.all(
              recipe.profile.assertions.map(async (a) => [
                a.file + a.pointer,
                String(await readAssertion(appPath, a)),
              ]),
            ),
          ),
        };
      },
    },
    defaultSettings: defaults,
    fields: recipe.features.flatMap((f) => [
      { id: `${f.id}.enabled`, type: "checkbox" as const, title: "启用", label: `安装时启用${f.title}` },
      ...(f.trigger === "shortcut"
        ? [{ id: `${f.id}.shortcut`, type: "text" as const, title: "快捷键" }]
        : []),
    ]),
    features: recipe.features.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      symbol: "plus",
      kind: "resource",
      fieldIds: [`${f.id}.enabled`, `${f.id}.shortcut`],
      enabledControl: { field: `${f.id}.enabled`, disabled: false, enabled: true },
      summarize: (s: Settings) =>
        s[`${f.id}.enabled`]
          ? f.trigger === "double-escape"
            ? `Esc → Esc · ${f.withinMs}ms`
            : String(s[`${f.id}.shortcut`])
          : "已关闭",
    })),
    validateSettings: validate,
    summarize: (s) =>
      recipe.features.map((f) => `${f.title}: ${s[`${f.id}.enabled`] ? "启用" : "关闭"}`).join(" · "),
    async identify(appPath) {
      await packageFile(appPath, recipe.profile.resource.path);
      for (const a of recipe.profile.assertions)
        if ((await readAssertion(appPath, a)) !== a.equals)
          throw new Error(`Version mismatch: ${a.file}${a.pointer}, expected ${a.equals}`);
      return {
        id: recipe.profile.id,
        label: recipe.profile.appVersion,
        artifactRelativePath: recipe.profile.resource.path,
        originalSha256: recipe.profile.resource.sha256,
      };
    },
    analyze,
    patch: (original, settings) => insert(original, render(validate(settings))),
    verifyPatch(source) {
      new Script(source);
      return "JavaScript parsed without execution; runtime behavior requires verification.";
    },
  };
}
async function readAssertion(appPath: string, a: Recipe["profile"]["assertions"][number]): Promise<unknown> {
  const value: unknown = JSON.parse(await fs.readFile(await packageFile(appPath, a.file), "utf8"));
  return a.pointer
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")]
          : undefined,
      value,
    );
}

async function packageFile(appPath: string, relative: string): Promise<string> {
  const root = await fs.realpath(appPath),
    file = await fs.realpath(path.join(root, relative));
  if (!file.startsWith(root + path.sep))
    throw new Error("Recipe resource/assertion escapes the selected App package");
  return file;
}
