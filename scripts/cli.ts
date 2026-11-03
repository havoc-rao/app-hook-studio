import path from "node:path";
import { configureResourceWorker } from "../src/core/resource-worker";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DEFAULT_APP_ID, APP_ADAPTERS, getAdapter } from "../src/apps/registry";
import { validateAppConfig } from "../src/core/contracts";
import { PatchEngine } from "../src/core/engine";
import { prepareAppInstall, restoreAppResources, adoptAppResources } from "../src/application/app-install";
import { getRecipe, registeredRecipes } from "../src/recipes/store";
import { recipeAdapter } from "../src/recipes/adapter";
import { loadConfig } from "../src/core/storage";

configureResourceWorker(path.join(__dirname, "../assets/resource-worker.cjs"));

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string", default: DEFAULT_APP_ID },
      action: { type: "string" },
      app: { type: "string" },
      config: { type: "string" },
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] ?? "list";
  if (
    values.help ||
    !["list", "status", "preflight", "apply", "restore", "adopt", "action"].includes(command) ||
    positionals.length > 1
  ) {
    console.log(
      "App Hook Studio\n\n用法：npm run cli -- <list|status|preflight|apply|restore|adopt|action> [--target codebuddy-cn] [--action <id>] [--app /path/to/App.app] [--config /path/to/settings.json] [--data-dir /path/to/app-data]\n\nstatus：只读检测；preflight：只读生成和验证补丁；adopt：在 App 内备份原文，不改资源代码，需先退出 App；apply/restore：需先退出目标应用。",
    );
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (command === "list") {
    const loaded = await registeredRecipes();
    for (const error of loaded.errors) console.error(`Registration error: ${error}`);
    console.log(
      JSON.stringify(
        [...APP_ADAPTERS, ...loaded.recipes.map(recipeAdapter)].map(({ id, title, supportDescription }) => ({
          id,
          title,
          supportDescription,
        })),
        null,
        2,
      ),
    );
    return;
  }
  const adapter = APP_ADAPTERS.some((a) => a.id === values.target)
    ? getAdapter(values.target)
    : recipeAdapter(await getRecipe(values.target));
  const engine = new PatchEngine(adapter, values["data-dir"]);
  if (command === "action") {
    const action = adapter.maintenanceActions?.find((item) => item.id === values.action);
    if (!action)
      throw new Error(
        `未知操作。可用操作：${adapter.maintenanceActions?.map((item) => item.id).join(", ") ?? "无"}`,
      );
    console.log(
      await action.run({
        appPath: values.app ?? adapter.defaultAppPath,
        dataDirectory: engine.dataDirectory,
      }),
    );
    return;
  }
  if (command !== "apply" && command !== "preflight") {
    const app = values.app ?? adapter.defaultAppPath;
    const result =
      command === "status"
        ? await engine.inspect(app)
        : command === "adopt"
          ? await adoptAppResources(adapter, app, engine.dataDirectory).then(() => engine.inspect(app))
          : await restoreAppResources(adapter, app, engine.dataDirectory).then(() => engine.inspect(app));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const saved = values.config
    ? JSON.parse(await readFile(values.config, "utf8"))
    : await loadConfig(adapter, engine.dataDirectory);
  const input = values.app ? { ...saved, appPath: values.app } : saved;
  const config = validateAppConfig(adapter, input);
  const plan = await prepareAppInstall(adapter, engine.dataDirectory, config);
  if (command === "preflight") {
    const { execute: _execute, ...report } = plan;
    console.log(JSON.stringify({ compatible: true, ...report }, null, 2));
    return;
  }
  const result = await plan.execute();
  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
