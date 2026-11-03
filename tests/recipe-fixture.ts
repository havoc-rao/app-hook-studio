import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/core/hash";
import { Recipe } from "../src/recipes/schema";
export async function recipeFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-recipe-"));
  const appPath = path.join(root, "Example.app"),
    resource = path.join(appPath, "Contents/main.js");
  await fs.mkdir(path.dirname(resource), { recursive: true });
  await fs.writeFile(path.join(appPath, "Contents/package.json"), '{"version":"1.0"}');
  const source = '"use strict";\n/* mount */\n';
  await fs.writeFile(resource, source);
  const recipe: Recipe = {
    schemaVersion: 2,
    id: "example-app",
    title: "Example",
    appPath,
    profile: {
      id: "example-v1",
      appVersion: "1.0",
      assertions: [{ file: "Contents/package.json", pointer: "/version", equals: "1.0" }],
      resource: { path: "Contents/main.js", sha256: sha256(source) },
      mount: { driver: "dom-keyboard/v1", anchor: "/* mount */", placement: "before", rootSelector: "#chat" },
    },
    features: [
      {
        id: "stop",
        title: "Stop",
        description: "Stop current chat",
        enabled: true,
        shortcut: "cmd+alt+s",
        trigger: "shortcut",
        withinMs: 500,
        action: "globalThis.actionRuns = (globalThis.actionRuns || 0) + 1;",
      },
    ],
    evidence: {
      sources: ["fixture://main.js"],
      runtimeStatus: "not-tested",
      notes: "Synthetic fixture only",
    },
  };
  return { root, data: path.join(root, "data"), recipe, resource, source };
}
