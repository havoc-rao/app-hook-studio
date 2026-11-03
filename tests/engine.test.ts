import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { codebuddyAdapter } from "../src/apps/codebuddy-cn/adapter";
import { defaultConfig } from "../src/core/contracts";
import { validateSettings } from "../src/apps/codebuddy-cn/settings";
const DEFAULT_CONFIG = defaultConfig(codebuddyAdapter);
import { PatchEngine } from "../src/core/engine";
import { BEGIN, analyzeBundle, patchBundle } from "../src/apps/codebuddy-cn/hook";
import { sha256 } from "../src/core/hash";
import { PROFILE } from "../src/apps/codebuddy-cn/profile";
import { loadConfig, saveConfig } from "../src/core/storage";

// Proprietary application bytes are supplied locally, never checked into this repository.
const originalPath = process.env.CODEBUDDY_TEST_ORIGINAL;
const legacyPath = process.env.CODEBUDDY_TEST_LEGACY;
const localOnly = {
  skip: originalPath
    ? false
    : "Set CODEBUDDY_TEST_ORIGINAL to a verified original bundle for local integration coverage",
};
async function fixture(source: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-test-"));
  const appPath = path.join(root, "CodeBuddy Fixture.app");
  const bundle = path.join(appPath, PROFILE.bundleRelativePath);
  const data = path.join(root, "state");
  const appRoot = path.join(appPath, "Contents/Resources/app");
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  await fs.writeFile(path.join(appRoot, "package.json"), JSON.stringify({ version: PROFILE.appVersion }));
  await fs.writeFile(
    path.join(appRoot, "extensions/genie/package.json"),
    JSON.stringify({ version: PROFILE.extensionVersion }),
  );
  await fs.writeFile(bundle, source, { mode: 0o644 });
  return { root, appPath, bundle, data, engine: new PatchEngine(codebuddyAdapter, data) };
}

test("settings persist independently from applying an application patch", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-settings-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(
    await loadConfig({ ...codebuddyAdapter, legacyConfig: undefined }, directory),
    DEFAULT_CONFIG,
  );
  await saveConfig(
    codebuddyAdapter,
    { ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, doubleEscapeMs: 750 } },
    directory,
  );
  assert.equal(
    (await loadConfig({ ...codebuddyAdapter, legacyConfig: undefined }, directory)).settings.doubleEscapeMs,
    750,
  );
  await fs.writeFile(path.join(directory, "settings.json"), "broken json");
  await assert.rejects(loadConfig({ ...codebuddyAdapter, legacyConfig: undefined }, directory), /无法读取/);
});

test("unknown bytes fail closed without backups or application writes", async (t) => {
  const f = await fixture("unknown application bytes");
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await assert.rejects(f.engine.apply({ ...DEFAULT_CONFIG, appPath: f.appPath }), /不受支持/);
  assert.equal(await fs.readFile(f.bundle, "utf8"), "unknown application bytes");
  await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
});

test("apply, reconfigure, idempotent apply and byte-exact restore", localOnly, async (t) => {
  const original = await fs.readFile(originalPath!, "utf8");
  assert.equal(sha256(original), PROFILE.originalSha256);
  const f = await fixture(original);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, appPath: f.appPath };
  assert.equal((await f.engine.inspect(f.appPath)).kind, "original");
  assert.equal((await f.engine.apply(config)).changed, true);
  const first = await f.engine.inspect(f.appPath);
  assert.equal(first.kind, "managed");
  assert.equal(first.backupState, "valid");
  assert.equal((await fs.stat(f.bundle)).mode & 0o777, 0o644);
  assert.equal((await f.engine.apply(config)).changed, false);
  await f.engine.apply({ ...config, settings: { ...config.settings, doubleEscapeMs: 750 } });
  const changed = await fs.readFile(f.bundle, "utf8");
  assert.equal(changed.split(BEGIN).length, 2);
  assert.equal(analyzeBundle(changed).installedSettings?.doubleEscapeMs, 750);
  assert.equal((await f.engine.restore(f.appPath)).changed, true);
  assert.equal(await fs.readFile(f.bundle, "utf8"), original);
  assert.equal((await f.engine.restore(f.appPath)).changed, false);
});

test("modified patches and corrupt backups are preserved, never overwritten", localOnly, async (t) => {
  const original = await fs.readFile(originalPath!, "utf8");
  const f = await fixture(original);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, appPath: f.appPath };
  const installed = await f.engine.apply(config);
  const altered = (await fs.readFile(f.bundle, "utf8")).replace("state.busy=true;", 'state.busy="foreign";');
  await fs.writeFile(f.bundle, altered);
  await assert.rejects(f.engine.restore(f.appPath), /未知改动/);
  assert.equal(await fs.readFile(f.bundle, "utf8"), altered);
  await fs.writeFile(f.bundle, patchBundle(original, validateSettings(config.settings)));
  await fs.writeFile(installed.inspection.backupPath, "damaged backup");
  await assert.rejects(f.engine.restore(f.appPath), /备份摘要不匹配/);
  assert.equal(await fs.readFile(installed.inspection.backupPath, "utf8"), "damaged backup");
  assert.equal(analyzeBundle(await fs.readFile(f.bundle, "utf8")).kind, "managed");
});

test(
  "existing verified prototype is adopted without changing installed bytes",
  {
    skip:
      originalPath && legacyPath
        ? false
        : "Set both CODEBUDDY_TEST_ORIGINAL and CODEBUDDY_TEST_LEGACY for migration coverage",
  },
  async (t) => {
    const legacy = await fs.readFile(legacyPath!, "utf8");
    const f = await fixture(legacy);
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const adopted = await f.engine.adopt(f.appPath);
    assert.equal(adopted.kind, "legacy");
    assert.equal(adopted.backupState, "valid");
    assert.equal(await fs.readFile(f.bundle, "utf8"), legacy);
    assert.equal(sha256(await fs.readFile(adopted.backupPath)), PROFILE.originalSha256);
    await f.engine.apply({ ...DEFAULT_CONFIG, appPath: f.appPath });
    assert.equal((await f.engine.inspect(f.appPath)).kind, "managed");
  },
);

test("CodeBuddy parses complete JavaScript without executing target code", () => {
  const profile = {
    id: PROFILE.id,
    label: "fixture",
    artifactRelativePath: PROFILE.bundleRelativePath,
    originalSha256: PROFILE.originalSha256,
  };
  assert.doesNotThrow(() => codebuddyAdapter.verifyPatch('throw new Error("must not execute");', profile));
  assert.throws(() => codebuddyAdapter.verifyPatch("function broken( {", profile), SyntaxError);
});

test("a different app version is rejected by read-only preflight", async (t) => {
  const f = await fixture("unsupported source");
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(f.appPath, "Contents/Resources/app/package.json"),
    JSON.stringify({ version: "999.0.0" }),
  );
  const report = await f.engine.preflight({ ...DEFAULT_CONFIG, appPath: f.appPath });
  assert.equal(report.compatible, false);
  assert.equal(report.checks.at(-1)?.id, "artifact");
  assert.match(report.checks.at(-1)?.detail ?? "", /999\.0\.0/);
  assert.equal(await fs.readFile(f.bundle, "utf8"), "unsupported source");
  await assert.rejects(fs.stat(f.data), { code: "ENOENT" });
});

test(
  "legacy external backups migrate inside the App even when resource bytes do not change",
  localOnly,
  async (t) => {
    const original = await fs.readFile(originalPath!, "utf8"),
      f = await fixture(original);
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const config = { ...DEFAULT_CONFIG, appPath: f.appPath };
    await fs.writeFile(f.bundle, patchBundle(original, validateSettings(config.settings)));
    const legacy = path.join(f.data, "backups", `${PROFILE.originalSha256}.original`);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, original);
    const report = await f.engine.preflight(config);
    assert.equal(report.compatible, true);
    if (!report.compatible) throw new Error("fixture preflight failed");
    assert.equal(report.willChange, false);
    assert.equal(report.willWriteBackup, true);
    assert.equal(report.inspection.backupLocation, "legacy-external");
    assert.equal(report.inspection.backupPath, legacy);
    await assert.rejects(fs.stat(report.inspection.backupDestinationPath), { code: "ENOENT" });
    const installed = await f.engine.apply(config);
    assert.equal(installed.changed, false);
    assert.equal(installed.inspection.backupLocation, "inside-app");
    assert.ok(
      installed.inspection.backupPath.startsWith(
        path.join(installed.inspection.appPath, "Contents/Resources/app-hook-studio-backups"),
      ),
    );
    assert.equal(await fs.readFile(legacy, "utf8"), original);
    const before = await fs.stat(installed.inspection.backupPath);
    await f.engine.apply({ ...config, settings: { ...config.settings, doubleEscapeMs: 650 } });
    assert.equal((await fs.stat(installed.inspection.backupPath)).mtimeMs, before.mtimeMs);
    await f.engine.restore(f.appPath);
    assert.equal(await fs.readFile(f.bundle, "utf8"), original);
    assert.equal(await fs.readFile(installed.inspection.backupPath, "utf8"), original);
  },
);

test("a corrupt in-App backup never falls back to a valid legacy backup", localOnly, async (t) => {
  const original = await fs.readFile(originalPath!, "utf8"),
    f = await fixture(original);
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, appPath: f.appPath };
  const installed = await f.engine.apply(config),
    source = await fs.readFile(f.bundle, "utf8");
  const legacy = path.join(f.data, "backups", `${PROFILE.originalSha256}.original`);
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, original);
  await fs.writeFile(installed.inspection.backupPath, "damaged primary");
  const status = await f.engine.inspect(f.appPath);
  assert.equal(status.backupLocation, "inside-app");
  assert.equal(status.backupState, "invalid");
  assert.equal((await f.engine.preflight(config)).compatible, false);
  await assert.rejects(f.engine.restore(f.appPath), /备份摘要不匹配/);
  assert.equal(await fs.readFile(f.bundle, "utf8"), source);
  assert.equal(await fs.readFile(installed.inspection.backupPath, "utf8"), "damaged primary");
});
