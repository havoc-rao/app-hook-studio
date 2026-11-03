import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { focusHostAdapter, HOST_PROFILE } from "../src/apps/codebuddy-cn/focus-host";
import { PROFILE } from "../src/apps/codebuddy-cn/profile";
import { defaultConfig } from "../src/core/contracts";
import { PatchEngine } from "../src/core/engine";
import { configureResourceWorker } from "../src/core/resource-worker";
const execute = promisify(execFile);
const original = process.env.CODEBUDDY_TEST_ORIGINAL,
  hostOriginal = process.env.CODEBUDDY_TEST_HOST;
const realSources = {
  skip: !original || !hostOriginal ? "Requires original CodeBuddy Webview and host sources" : false,
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-resource-worker-")),
    appPath = path.join(root, "Fixture.app");
  const artifact = path.join(appPath, HOST_PROFILE.artifactRelativePath);
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(
    path.join(appPath, "Contents/Resources/app/package.json"),
    JSON.stringify({ version: PROFILE.appVersion }),
  );
  await fs.writeFile(
    path.join(appPath, "Contents/Resources/app/extensions/genie/package.json"),
    JSON.stringify({ version: PROFILE.extensionVersion }),
  );
  await fs.copyFile(hostOriginal!, artifact);
  const webview = path.join(appPath, PROFILE.bundleRelativePath);
  await fs.mkdir(path.dirname(webview), { recursive: true });
  await fs.copyFile(original!, webview);
  const keybindings = path.join(root, "keybindings.json");
  await fs.writeFile(keybindings, "[]\n");
  return { root, appPath, artifact, keybindings, directory: path.join(root, "data") };
}

test(
  "whole-App preflight completes in a 100 MB command with real 21 MB host and simulated UI overhead",
  realSources,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const { stdout } = await execute(
      process.execPath,
      [path.resolve("dist/resource-memory-check.cjs"), JSON.stringify(f)],
      { timeout: 20000, maxBuffer: 8192 },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.items, 3);
    assert.equal(report.checks, 11);
    assert.equal(report.restartRequired, true);
    assert.ok(report.heapUsed < 100 * 1024 * 1024);
    assert.equal(report.uiReserveBytes, 16 * 1024 * 1024);
    await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
  },
);

test(
  "isolated engine owns real-source apply, idempotence, inspect and exact restore with compact replies",
  realSources,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const engine = new PatchEngine(focusHostAdapter, f.directory),
      config = { ...defaultConfig(focusHostAdapter), appPath: f.appPath };
    const plan = await engine.preflight(config);
    assert.equal(plan.compatible, true);
    await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
    const installed = await engine.apply(config);
    assert.equal(installed.changed, true);
    assert.ok(JSON.stringify(installed).length < 8192);
    assert.equal((await engine.inspect(f.appPath)).kind, "managed");
    assert.equal((await engine.apply(config)).changed, false);
    assert.equal((await engine.restore(f.appPath)).changed, true);
    assert.deepEqual(await fs.readFile(f.artifact), await fs.readFile(hostOriginal!));
  },
);

test("missing worker and target errors are reported; the serialization queue recovers", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-worker-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const validScript = path.resolve("assets/resource-worker.cjs");
  const engine = new PatchEngine(focusHostAdapter, path.join(root, "data"));
  configureResourceWorker(path.join(root, "missing.cjs"));
  await assert.rejects(engine.inspect(path.join(root, "Missing.app")), /独立资源处理进程失败/);
  configureResourceWorker(validScript);
  await assert.rejects(engine.inspect(path.join(root, "Missing.app")), /ENOENT/);
  const { stdout } = await execute(process.execPath, [
    validScript,
    JSON.stringify({ protocol: 1, operation: "health" }),
  ]);
  assert.equal(JSON.parse(stdout).ok, true);
});
