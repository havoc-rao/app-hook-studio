import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppAdapter, defaultConfig, validateAppConfig } from "../src/core/contracts";
import { PatchEngine } from "../src/core/engine";
import { sha256 } from "../src/core/hash";
import { appDataDirectory, loadConfig } from "../src/core/storage";
import { APP_ADAPTERS, getAdapter } from "../src/apps/registry";

const original = "fixture application resource\n";
/** Test-only adapter: proves the shared core does not depend on CodeBuddy, React or hotkey fields. */
function fixtureAdapter(id: string, defaultAppPath: string): AppAdapter {
  const validateSettings = (raw: unknown) => {
    const v = raw as Record<string, unknown>;
    if (!v || typeof v.message !== "string") throw new Error("message required");
    return { message: v.message };
  };
  return {
    id,
    title: id,
    description: "test-only fixture",
    supportDescription: "synthetic text resource",
    defaultAppPath,
    defaultSettings: { message: "hello" },
    fields: [{ id: "message", type: "text", title: "Message" }],
    features: [
      {
        id: "message",
        title: "Message",
        description: "Test feature",
        symbol: "plus",
        kind: "resource",
        fieldIds: ["message"],
        summarize: (settings) => String(settings.message),
      },
    ],
    validateSettings,
    summarize: (settings) => String(settings.message),
    async identify() {
      return {
        id: `${id}-v1`,
        label: "Fixture v1",
        artifactRelativePath: "Contents/Resources/mock.txt",
        originalSha256: sha256(original),
      };
    },
    analyze(source) {
      if (source === original) return { kind: "original", original };
      if (!source.startsWith(original)) throw new Error("unknown original");
      const settings = validateSettings(JSON.parse(source.slice(original.length)));
      if (source !== original + JSON.stringify(settings)) throw new Error("unknown patch");
      return { kind: "managed", original, installedSettings: settings };
    },
    patch: (source, settings) => source + JSON.stringify(validateSettings(settings)),
    verifyPatch(source) {
      JSON.parse(source.slice(original.length));
      return "测试资源的 JSON 格式有效；未执行代码。";
    },
  };
}

test("registered applications declare their own complete configuration fields", () => {
  for (const adapter of APP_ADAPTERS) {
    assert.equal(getAdapter(adapter.id), adapter);
    assert.deepEqual(
      validateAppConfig(adapter, defaultConfig(adapter)).settings,
      adapter.validateSettings(adapter.defaultSettings),
    );
    assert.equal(new Set(adapter.fields.map((field) => field.id)).size, adapter.fields.length);
    assert.deepEqual(
      new Set(adapter.fields.map((field) => field.id)),
      new Set(Object.keys(adapter.defaultSettings)),
    );
  }
  assert.throws(() => getAdapter("unknown-app"), /未知应用/);
});

test("independent app adapters share the engine with isolated state and recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-adapters-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alpha = fixtureAdapter("alpha", path.join(root, "Alpha.app"));
  const beta = fixtureAdapter("beta", path.join(root, "Beta.app"));
  const artifact = (adapter: AppAdapter) => path.join(adapter.defaultAppPath, "Contents/Resources/mock.txt");
  for (const adapter of [alpha, beta]) {
    await fs.mkdir(path.dirname(artifact(adapter)), { recursive: true });
    await fs.writeFile(artifact(adapter), original);
  }
  const a = new PatchEngine(alpha, path.join(root, "data", alpha.id));
  const b = new PatchEngine(beta, path.join(root, "data", beta.id));
  assert.notEqual(appDataDirectory(alpha.id), appDataDirectory(beta.id));
  await a.apply(defaultConfig(alpha));
  assert.equal(await fs.readFile(artifact(beta), "utf8"), original);
  const betaConfig = { ...defaultConfig(beta), settings: { message: "beta-only" } };
  await b.apply(betaConfig);
  await assert.rejects(a.apply(betaConfig), /不属于/);
  await a.restore(alpha.defaultAppPath);
  assert.equal(await fs.readFile(artifact(alpha), "utf8"), original);
  assert.deepEqual((await b.inspect(beta.defaultAppPath)).installedConfig?.settings, {
    message: "beta-only",
  });
  await b.restore(beta.defaultAppPath);
  assert.equal(await fs.readFile(artifact(beta), "utf8"), original);
});

test("legacy settings are read without deleting or overwriting the prior project data", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy-settings.json");
  const bytes = JSON.stringify({ path: "/Applications/Test.app", oldMessage: "preserved" });
  await fs.writeFile(legacy, bytes);
  const adapter = fixtureAdapter("migrated", "/Applications/Test.app");
  adapter.legacyConfig = {
    path: legacy,
    decode: (raw) => {
      const v = raw as { path: string; oldMessage: string };
      return { appPath: v.path, settings: { message: v.oldMessage } };
    },
  };
  const config = await loadConfig(adapter, path.join(root, "new-state"));
  assert.equal(config.settings.message, "preserved");
  assert.equal(await fs.readFile(legacy, "utf8"), bytes);
  await assert.rejects(fs.stat(path.join(root, "new-state")), { code: "ENOENT" });
});

test("the shared engine rejects a producer that emits the wrong configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = fixtureAdapter("faulty", path.join(root, "Faulty.app"));
  adapter.patch = () => original + JSON.stringify({ message: "wrong" });
  const artifact = path.join(adapter.defaultAppPath, "Contents/Resources/mock.txt");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, original);
  const state = path.join(root, "data");
  await assert.rejects(new PatchEngine(adapter, state).apply(defaultConfig(adapter)), /契约验证/);
  assert.equal(await fs.readFile(artifact, "utf8"), original);
  await assert.rejects(fs.stat(state), { code: "ENOENT" });
});

test("preflight generates and validates a patch without creating any files", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-preflight-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = fixtureAdapter("preview", path.join(root, "Preview.app"));
  const artifact = path.join(adapter.defaultAppPath, "Contents/Resources/mock.txt");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, original);
  const data = path.join(root, "data");
  const engine = new PatchEngine(adapter, data);
  const report = await engine.preflight(defaultConfig(adapter));
  assert.equal(report.compatible, true);
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every((check) => check.status === "pass"));
  if (report.compatible) {
    assert.equal(report.willChange, true);
    assert.equal(report.inspection.backupState, "missing");
    assert.equal(
      report.candidateSha256,
      sha256(adapter.patch(original, adapter.defaultSettings, report.inspection.profile)),
    );
  }
  assert.equal(await fs.readFile(artifact, "utf8"), original);
  await assert.rejects(fs.stat(data), { code: "ENOENT" });
});

test("apply rechecks a target changed after a successful preflight", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-stale-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = fixtureAdapter("stale", path.join(root, "Stale.app"));
  const artifact = path.join(adapter.defaultAppPath, "Contents/Resources/mock.txt");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, original);
  const data = path.join(root, "data");
  const engine = new PatchEngine(adapter, data);
  assert.equal((await engine.preflight(defaultConfig(adapter))).compatible, true);
  const changed = "updated application resource\n";
  await fs.writeFile(artifact, changed);
  await assert.rejects(engine.apply(defaultConfig(adapter)), /unknown original/);
  assert.equal(await fs.readFile(artifact, "utf8"), changed);
  await assert.rejects(fs.stat(data), { code: "ENOENT" });
});

test("static validation failure blocks preflight and apply before any backup", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-invalid-candidate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapter = fixtureAdapter("invalid", path.join(root, "Invalid.app"));
  adapter.verifyPatch = () => {
    throw new SyntaxError("invalid candidate syntax");
  };
  const artifact = path.join(adapter.defaultAppPath, "Contents/Resources/mock.txt");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, original);
  const data = path.join(root, "data");
  const engine = new PatchEngine(adapter, data);
  const report = await engine.preflight(defaultConfig(adapter));
  assert.equal(report.compatible, false);
  assert.deepEqual(report.checks.at(-1), {
    id: "static-validation",
    label: "完整资源静态验证",
    status: "fail",
    detail: "invalid candidate syntax",
  });
  await assert.rejects(engine.apply(defaultConfig(adapter)), /invalid candidate syntax/);
  assert.equal(await fs.readFile(artifact, "utf8"), original);
  await assert.rejects(fs.stat(data), { code: "ENOENT" });
});
