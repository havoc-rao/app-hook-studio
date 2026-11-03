/** Reproduces Raycast's per-command budget, with 16 MiB reserved to model UI overhead. No App writes. */
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import path from "node:path";
import { codebuddyAdapter } from "../src/apps/codebuddy-cn/adapter";
import { prepareAppInstall } from "../src/application/app-install";
import { defaultConfig } from "../src/core/contracts";
import { configureResourceWorker } from "../src/core/resource-worker";
configureResourceWorker(path.join(__dirname, "../assets/resource-worker.cjs"));
async function main() {
  if (isMainThread) {
    const request: unknown = JSON.parse(process.argv[2] ?? "null");
    const worker = new Worker(__filename, {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: 100 },
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      let report: unknown;
      worker.on("message", (value: unknown) => {
        report = value;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0 || !report) reject(new Error(`Constrained command exited ${code}`));
        else resolve(report);
      });
    });
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const { appPath, directory, keybindings } = workerData as {
    appPath: string;
    directory: string;
    keybindings: string;
  };
  const reserve = new Array(2 * 1024 * 1024).fill(7);
  const adapter = {
    ...codebuddyAdapter,
    defaultAppPath: appPath,
    features: codebuddyAdapter.features.map((feature) =>
      feature.kind === "ide-keybinding" ? { ...feature, targetFile: keybindings } : feature,
    ),
  };
  const started = performance.now();
  const plan = await prepareAppInstall(adapter, directory, defaultConfig(adapter));
  parentPort!.postMessage({
    checks: plan.checks.length,
    items: plan.items.length,
    heapUsed: process.memoryUsage().heapUsed,
    elapsedMs: performance.now() - started,
    uiReserveBytes: reserve.length * 8,
    restartRequired: plan.restartRequired,
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
