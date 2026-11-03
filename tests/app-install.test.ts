import { PatchEngine } from "../src/core/engine";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { codebuddyAdapter } from "../src/apps/codebuddy-cn/adapter";
import { PROFILE } from "../src/apps/codebuddy-cn/profile";
import { BEGIN, analyzeBundle } from "../src/apps/codebuddy-cn/hook";
import { recipeAdapter } from "../src/recipes/adapter";
import { sha256 } from "../src/core/hash";
import { defaultConfig } from "../src/core/contracts";
import {
  appInstallRequirements,
  restoreAppResources,
  adoptAppResources,
  prepareAppInstall,
  saveNativePreferences,
  loadNativePreferences,
} from "../src/application/app-install";
import { IdeKeybindingInstaller } from "../src/installers/ide-keybinding";

const originalPath = process.env.CODEBUDDY_TEST_ORIGINAL;
const localOnly = {
  skip: originalPath ? false : "Provide CODEBUDDY_TEST_ORIGINAL for real-resource app-install verification",
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-app-install-"));
  const appPath = path.join(root, "Fixture.app");
  const appRoot = path.join(appPath, "Contents/Resources/app");
  const artifact = path.join(appPath, PROFILE.bundleRelativePath);
  const target = path.join(root, "keybindings.json");
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ version: PROFILE.appVersion }));
  await fs.writeFile(
    path.join(appRoot, "extensions/genie/package.json"),
    JSON.stringify({ version: PROFILE.extensionVersion }),
  );
  const source = await fs.readFile(originalPath!, "utf8");
  await fs.writeFile(artifact, source);
  await fs.writeFile(target, "// keep comment\n[]\n");
  const bridgePath = path.join(appPath, "Contents/fixture-host.js"),
    bridgeSource = "/* bridge mount */\n";
  await fs.writeFile(bridgePath, bridgeSource);
  const bridge = recipeAdapter({
    schemaVersion: 2,
    id: "fixture-focus-bridge",
    title: "Fixture Bridge",
    appPath,
    profile: {
      id: "fixture-build",
      appVersion: PROFILE.appVersion,
      assertions: [
        { file: "Contents/Resources/app/package.json", pointer: "/version", equals: PROFILE.appVersion },
      ],
      resource: { path: "Contents/fixture-host.js", sha256: sha256(bridgeSource) },
      mount: {
        driver: "dom-keyboard/v1",
        anchor: "/* bridge mount */",
        placement: "before",
        rootSelector: "#chat",
      },
    },
    features: [
      {
        id: "bridge",
        title: "Bridge",
        description: "Synthetic bridge resource",
        enabled: true,
        shortcut: "cmd+alt+b",
        trigger: "shortcut",
        withinMs: 500,
        action: "void root;",
      },
    ],
    evidence: {
      sources: ["fixture"],
      runtimeStatus: "not-tested",
      notes: "Orchestration fixture, not host runtime proof",
    },
  });
  const adapter = {
    ...codebuddyAdapter,
    defaultAppPath: appPath,
    features: codebuddyAdapter.features.map((feature) =>
      feature.kind === "ide-keybinding"
        ? { ...feature, targetFile: target, resourceBridge: bridge }
        : feature,
    ),
  };
  return { root, adapter, artifact, bridgePath, bridgeSource, target, source, data: path.join(root, "data") };
}

test("app installation distinguishes package permissions from native-only permissions", () => {
  assert.match(appInstallRequirements(codebuddyAdapter).permission, /App 管理/);
  assert.match(appInstallRequirements(codebuddyAdapter).before, /⌘Q/);
  assert.match(appInstallRequirements(codebuddyAdapter).after, /重新打开/);
  const nativeOnly = {
    ...codebuddyAdapter,
    features: codebuddyAdapter.features
      .filter((feature) => feature.kind === "ide-keybinding")
      .map((feature) => ({ ...feature, resourceBridge: undefined })),
  };
  assert.match(appInstallRequirements(nativeOnly).permission, /不修改 .app/);
  assert.match(appInstallRequirements(nativeOnly).before, /无需退出/);
});

test(
  "whole-app plan is read-only; execute installs all three configured items with one resource patch",
  localOnly,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const plan = await prepareAppInstall(f.adapter, f.data, defaultConfig(f.adapter));
    assert.deepEqual(
      plan.items.map((item) => item.id),
      ["new-chat", "stop-chat", "focus-input"],
    );
    assert.equal(plan.restartRequired, true);
    assert.equal(await fs.readFile(f.artifact, "utf8"), f.source);
    assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 0);
    await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
    const result = await plan.execute();
    assert.equal(result.complete, true);
    assert.equal(result.steps.length, 4);
    assert.notEqual(await fs.readFile(f.bridgePath, "utf8"), f.bridgeSource);
    const installed = await fs.readFile(f.artifact, "utf8");
    assert.equal(installed.split(BEGIN).length, 2);
    assert.equal(analyzeBundle(installed).installedSettings?.newChatEnabled, true);
    assert.equal(analyzeBundle(installed).installedSettings?.stopMode, "double-escape");
    assert.equal(parse(await fs.readFile(f.target, "utf8"))[0].key, "cmd+i");
  },
);

test("whole-app install respects native enabled state saved on its feature page", localOnly, async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await saveNativePreferences(path.join(f.data, "focus-keybinding"), { key: "cmd+shift+i", enabled: false });
  const plan = await prepareAppInstall(f.adapter, f.data, defaultConfig(f.adapter));
  assert.equal(plan.items.find((item) => item.id === "focus-input")?.settings, "已关闭");
  assert.equal((await plan.execute()).complete, true);
  assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 0);
  assert.equal(
    analyzeBundle(await fs.readFile(f.artifact, "utf8")).installedSettings?.stopMode,
    "double-escape",
  );
});

test(
  "a later-stage failure reports partial app installation; retry completes without duplicate hooks",
  localOnly,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const plan = await prepareAppInstall(f.adapter, f.data, defaultConfig(f.adapter));
    const install = IdeKeybindingInstaller.prototype.install;
    let partial;
    try {
      IdeKeybindingInstaller.prototype.install = async () => {
        throw new Error("fixture write permission denied");
      };
      partial = await plan.execute();
    } finally {
      IdeKeybindingInstaller.prototype.install = install;
    }
    assert.equal(partial.complete, false);
    assert.deepEqual(
      partial.steps.map((step) => step.status),
      ["done", "done", "failed", "skipped"],
    );
    assert.match(partial.steps[2].detail, /permission denied/);
    assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 0);
    const retried = await plan.execute();
    assert.equal(retried.complete, true);
    assert.equal((await fs.readFile(f.artifact, "utf8")).split(BEGIN).length, 2);
    assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 1);
  },
);

test("legacy key-only preferences preserve a previously disabled managed rule", localOnly, async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const feature = f.adapter.features.find((item) => item.kind === "ide-keybinding")!;
  if (feature.kind !== "ide-keybinding") throw new Error("missing native feature");
  const directory = path.join(f.data, "focus-keybinding");
  const manager = new IdeKeybindingInstaller(
    feature.targetFile,
    directory,
    {
      key: "cmd+i",
      command: feature.command,
      ...(feature.commandArguments ? { args: feature.commandArguments } : {}),
    },
    feature.id,
  );
  await manager.install();
  await manager.restore();
  await fs.writeFile(path.join(directory, "preferences.json"), JSON.stringify({ key: "cmd+i" }));
  assert.deepEqual(await loadNativePreferences(feature, directory), { key: "cmd+i", enabled: false });
  await fs.unlink(path.join(directory, "preferences.json"));
  assert.equal((await loadNativePreferences(feature, directory)).enabled, false);
});

test(
  "a changed companion resource blocks every write; whole-resource restore checks both backups first",
  localOnly,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const plan = await prepareAppInstall(f.adapter, f.data, defaultConfig(f.adapter));
    await fs.writeFile(f.bridgePath, "unknown companion");
    const blocked = await plan.execute();
    assert.equal(blocked.complete, false);
    assert.equal(blocked.steps[0].id, "preflight");
    assert.equal(await fs.readFile(f.artifact, "utf8"), f.source);
    assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 0);
    await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
    await fs.writeFile(f.bridgePath, f.bridgeSource);
    assert.equal((await plan.execute()).complete, true);
    const installed = await fs.readFile(f.artifact, "utf8");
    const feature = f.adapter.features.find((item) => item.kind === "ide-keybinding")!;
    if (feature.kind !== "ide-keybinding") throw new Error("missing native feature");
    const bridgeEngine = new PatchEngine(
      feature.resourceBridge!,
      path.join(f.data, feature.dataSubdirectory, "bridge"),
    );
    const { backupPath } = await bridgeEngine.inspect(f.adapter.defaultAppPath);
    await fs.writeFile(backupPath, "invalid backup");
    await assert.rejects(restoreAppResources(f.adapter, f.adapter.defaultAppPath, f.data), /备份校验失败/);
    assert.equal(await fs.readFile(f.artifact, "utf8"), installed);
    await fs.writeFile(backupPath, f.bridgeSource);
    await restoreAppResources(f.adapter, f.adapter.defaultAppPath, f.data);
    assert.equal(await fs.readFile(f.artifact, "utf8"), f.source);
    assert.equal(await fs.readFile(f.bridgePath, "utf8"), f.bridgeSource);
  },
);

test(
  "whole-App backup action stores both resource originals inside the App without changing code or user rules",
  localOnly,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    await adoptAppResources(f.adapter, f.adapter.defaultAppPath, f.data);
    const main = await new PatchEngine(f.adapter, f.data).inspect(f.adapter.defaultAppPath);
    const feature = f.adapter.features.find((item) => item.kind === "ide-keybinding")!;
    if (feature.kind !== "ide-keybinding") throw new Error("missing native feature");
    const bridge = await new PatchEngine(
      feature.resourceBridge!,
      path.join(f.data, feature.dataSubdirectory, "bridge"),
    ).inspect(f.adapter.defaultAppPath);
    assert.equal(main.backupLocation, "inside-app");
    assert.equal(bridge.backupLocation, "inside-app");
    assert.equal(main.backupState, "valid");
    assert.equal(bridge.backupState, "valid");
    assert.equal(await fs.readFile(f.artifact, "utf8"), f.source);
    assert.equal(await fs.readFile(f.bridgePath, "utf8"), f.bridgeSource);
    assert.equal(parse(await fs.readFile(f.target, "utf8")).length, 0);
  },
);

test(
  "backup-only migration requires App exit while preserving runtime restart semantics",
  localOnly,
  async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    await (await prepareAppInstall(f.adapter, f.data, defaultConfig(f.adapter))).execute();
    const mainEngine = new PatchEngine(f.adapter, f.data);
    const feature = f.adapter.features.find((item) => item.kind === "ide-keybinding")!;
    if (feature.kind !== "ide-keybinding") throw new Error("missing native feature");
    const bridgeData = path.join(f.data, feature.dataSubdirectory, "bridge");
    const bridgeEngine = new PatchEngine(feature.resourceBridge!, bridgeData);
    for (const [engine, data] of [
      [mainEngine, f.data],
      [bridgeEngine, bridgeData],
    ] as const) {
      const inspection = await engine.inspect(f.adapter.defaultAppPath);
      const legacy = path.join(data, "backups", `${inspection.profile.originalSha256}.original`);
      await fs.mkdir(path.dirname(legacy), { recursive: true });
      await fs.rename(inspection.backupPath, legacy);
    }
    const plan = await prepareAppInstall(f.adapter, f.data);
    assert.equal(plan.restartRequired, false);
    assert.equal(plan.requiresAppExit, true);
    assert.equal(
      plan.backups.every((backup) => backup.migrationRequired),
      true,
    );
    assert.equal((await plan.execute()).complete, true);
    assert.equal((await mainEngine.inspect(f.adapter.defaultAppPath)).backupLocation, "inside-app");
    assert.equal((await bridgeEngine.inspect(f.adapter.defaultAppPath)).backupLocation, "inside-app");
  },
);
