import {
  beginSnapshot,
  checkSnapshotInstall,
  finishSnapshot,
  fileDigest,
  withSnapshotLock,
  SnapshotTarget,
  hasSnapshot,
  inspectSnapshotRestore,
  importLegacySnapshot,
  restoreSnapshot,
} from "./app-snapshot";
import { sha256 } from "../core/hash";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppAdapter, AppConfig, AppFeature, validateAppConfig, defaultConfig } from "../core/contracts";
import { PatchEngine, PreflightCheck, requireAppClosed } from "../core/engine";
import { loadConfig, saveConfig, appDataDirectory, isMissing, writeAtomic } from "../core/storage";
import { toIdeShortcut } from "../core/shortcuts";
import { featureKeybindingInstaller } from "../installers/ide-keybinding";

export type NativePreferences = { key: string; enabled: boolean };
export type NativeFeature = Extract<AppFeature, { kind: "ide-keybinding" }>;
export async function loadNativePreferences(
  feature: NativeFeature,
  directory: string,
): Promise<NativePreferences> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, "preferences.json"), "utf8"));
    const v = value as Record<string, unknown>;
    if (!v || typeof v.key !== "string" || (v.enabled !== undefined && typeof v.enabled !== "boolean"))
      throw new Error("快捷键设置格式异常。");
    const key = toIdeShortcut(v.key);
    const current =
      v.enabled === undefined
        ? await featureKeybindingInstaller(feature, directory, key).inspect()
        : undefined;
    return { key, enabled: v.enabled === undefined ? current!.enabled : v.enabled };
  } catch (error) {
    if (!isMissing(error)) throw error;
    const current = await featureKeybindingInstaller(feature, directory).inspect();
    return {
      key: current.binding?.key ?? feature.defaultShortcut,
      enabled: current.hasInstallRecord ? current.enabled : true,
    };
  }
}
export async function saveNativePreferences(directory: string, value: NativePreferences): Promise<void> {
  const key = toIdeShortcut(value.key);
  if (typeof value.enabled !== "boolean") throw new Error("启用状态无效。");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(
    path.join(directory, "preferences.json"),
    JSON.stringify({ key, enabled: value.enabled }, null, 2) + "\n",
  );
}

export type InstallStep = {
  id: string;
  title: string;
  status: "done" | "failed" | "skipped";
  detail: string;
};
export type AppInstallResult = {
  complete: boolean;
  steps: InstallStep[];
  nextStep: string;
  restartRequired: boolean;
};
export type AppInstallPlan = {
  appPath: string;
  requiresAppExit: boolean;
  backups: { title: string; destination: string; current: string; migrationRequired: boolean }[];
  items: { id: string; title: string; settings: string; target: string }[];
  checks: PreflightCheck[];
  permission: string;
  before: string;
  after: string;
  restartRequired: boolean;
  execute(): Promise<AppInstallResult>;
};
export function appInstallRequirements(adapter: AppAdapter) {
  const resources = adapter.features.some(
    (feature) => feature.kind === "resource" || !!feature.resourceBridge,
  );
  return {
    permission: resources
      ? "修改应用包时，Raycast 需具备“App 管理”授权和资源写权限：系统设置 → 隐私与安全性 → App 管理 → Raycast。终端授权不能代替 Raycast。聚焦快捷键另外需要用户配置文件写权限。实际写权限在安装时判断。"
      : "需要用户配置文件写权限，以及 App 内完整备份目录的写权限；Raycast 可能需要“App 管理”授权。",
    before: resources
      ? `更新应用资源或创建/迁移包内备份时，请先保存工作并用 ⌘Q 完全退出 ${adapter.title}。安装会检查运行状态，不会自动强退。`
      : `请先保存工作并用 ⌘Q 退出 ${adapter.title}，安装前需要写入包内完整备份。`,
    after: resources
      ? `应用资源有变化时，安装后重新打开 ${adapter.title} 并验证快捷键。若先前安装后一直没有重新打开，也应重新打开；仅更新聚焦配置通常即时生效。`
      : "通常立即生效，必要时重新加载 App 窗口。",
  };
}

/** A shared companion is installed/restored once, even when several features use it. */
function companions(adapter: AppAdapter, directory: string) {
  const items = new Map<string, { id: string; title: string; engine: PatchEngine; adapter: AppAdapter }>();
  for (const feature of adapter.features) {
    const bridge =
      feature.kind === "ide-keybinding" ? feature.resourceBridge : feature.resourceTarget?.adapter;
    if (!bridge) continue;
    const data =
      feature.kind === "ide-keybinding"
        ? path.join(directory, feature.dataSubdirectory, "bridge")
        : path.join(directory, feature.resourceTarget!.dataSubdirectory);
    const previous = items.get(bridge.id);
    if (previous) {
      if (previous.engine.dataDirectory !== data || previous.adapter !== bridge)
        throw new Error(`共享资源 ${bridge.id} 的适配器或配置目录不一致。`);
      continue;
    }
    items.set(bridge.id, {
      id: `bridge:${feature.id}`,
      title: bridge.title,
      adapter: bridge,
      engine: new PatchEngine(bridge, data),
    });
  }
  return [...items.values()];
}

export function featureResourceEngine(
  adapter: AppAdapter,
  feature: Extract<AppFeature, { kind: "resource" }>,
  directory = appDataDirectory(adapter.id),
) {
  return feature.resourceTarget
    ? new PatchEngine(
        feature.resourceTarget.adapter,
        path.join(directory, feature.resourceTarget.dataSubdirectory),
      )
    : new PatchEngine(adapter, directory);
}

/** One app, deduplicated resource patches, and all configured host shortcuts. Preparation never writes. */
export async function prepareAppInstall(
  adapter: AppAdapter,
  directory = appDataDirectory(adapter.id),
  supplied?: AppConfig,
): Promise<AppInstallPlan> {
  const config = validateAppConfig(adapter, supplied ?? (await loadConfig(adapter, directory)));
  await checkSnapshotInstall(config.appPath);
  const engine = new PatchEngine(adapter, directory);
  const resources = adapter.features.filter(
    (feature) => feature.kind === "resource" && !feature.resourceTarget,
  );
  const native = await Promise.all(
    adapter.features
      .filter((feature): feature is NativeFeature => feature.kind === "ide-keybinding")
      .map(async (feature) => {
        const data = path.join(directory, feature.dataSubdirectory);
        const preferences = await loadNativePreferences(feature, data);
        const manager = featureKeybindingInstaller(feature, data, preferences.key);
        await manager.inspect();
        return { feature, data, preferences, manager };
      }),
  );
  if (!resources.length && native.some((item) => item.preferences.enabled))
    await adapter.identify(config.appPath);
  const tasks = [
    ...(resources.length ? [{ id: "chat-resource", title: "App 资源补丁", engine, config }] : []),
    ...companions(adapter, directory).map(({ adapter: bridge, ...task }) => ({
      ...task,
      config: { ...defaultConfig(bridge), appPath: config.appPath },
    })),
  ];
  const reports = await Promise.all(
    tasks.map(async (task) => {
      const report = await task.engine.preflight(task.config);
      if (!report.compatible)
        throw new Error(
          `${task.title}：${report.checks.find((check) => check.status === "fail")?.detail ?? "预检查失败"}`,
        );
      return { task, report };
    }),
  );
  const resourceTarget =
    reports.find(({ task }) => task.id === "chat-resource")?.report.inspection.artifactPath ?? "";
  if (!(await hasSnapshot(config.appPath))) {
    const ownedBindings = await Promise.all(native.map((item) => item.manager.inspect()));
    if (
      reports.some(({ report }) => report.inspection.kind !== "original") ||
      ownedBindings.some((item) => item.kind === "managed" || item.kind === "legacy")
    )
      throw new Error("发现旧版安装，请先 Restore 完整恢复，再 Install；不会将旧补丁保存为首次基线。");
  }
  const requirements = appInstallRequirements(adapter);
  const restartRequired = reports.some(({ report }) => report.willChange);
  const requiresAppExit = true;
  return {
    appPath: config.appPath,
    ...requirements,
    restartRequired,
    requiresAppExit,
    backups: reports.map(({ task, report }) => ({
      title: task.title,
      destination: report.inspection.backupDestinationPath,
      current: report.inspection.backupPath,
      migrationRequired: report.inspection.backupLocation === "legacy-external",
    })),
    items: adapter.features.map((feature) => {
      if (feature.kind === "resource")
        return {
          id: feature.id,
          title: feature.title,
          settings: feature.summarize(config.settings),
          target: feature.resourceTarget
            ? (reports.find(({ task }) => task.engine.adapter.id === feature.resourceTarget!.adapter.id)
                ?.report.inspection.artifactPath ?? "")
            : resourceTarget,
        };
      const item = native.find((item) => item.feature.id === feature.id)!;
      return {
        id: feature.id,
        title: feature.title,
        settings: item.preferences.enabled ? `${item.preferences.key} · 应用内全局` : "已关闭",
        target: [
          feature.targetFile,
          ...reports
            .filter(({ task }) => task.engine.adapter.id === feature.resourceBridge?.id)
            .map(({ report }) => report.inspection.artifactPath),
        ].join("\n"),
      };
    }),
    checks: [
      ...reports.flatMap(({ task, report }) =>
        report.checks.map((check) => ({
          ...check,
          id: `${task.id}:${check.id}`,
          label: `${task.title} · ${check.label}`,
        })),
      ),
      ...native.map((item) => ({
        id: `native:${item.feature.id}`,
        label: item.feature.title,
        status: "pass" as const,
        detail: "已读取快捷键配置及所有权记录。",
      })),
    ],
    async execute() {
      await requireAppClosed(config.appPath, adapter.title);
      return withSnapshotLock(config.appPath, async () => {
        const steps: InstallStep[] = [];
        const stageNames = [
          ...tasks.map(({ id, title }) => ({ id, title })),
          ...native.map((item) => ({ id: `native:${item.feature.id}`, title: item.feature.title })),
          { id: "preferences", title: "记录 App 配置" },
        ];
        let needsRestart = false;
        try {
          // Validate every destination again before the first mutation.
          await checkSnapshotInstall(config.appPath);
          const targets: SnapshotTarget[] = [];
          let willChange = false;
          for (const task of tasks) {
            const fresh = await task.engine.preflight(task.config);
            if (!fresh.compatible)
              throw new Error(
                `${task.title}：${fresh.checks.find((check) => check.status === "fail")?.detail ?? "预检查失败"}`,
              );
            willChange ||= fresh.willChange || fresh.willWriteBackup;
            targets.push({
              target: fresh.inspection.artifactPath,
              title: task.title,
              after: fresh.candidateSha256,
            });
          }
          if (willChange) await requireAppClosed(config.appPath, adapter.title);
          if (!tasks.length && native.some((item) => item.preferences.enabled))
            await adapter.identify(config.appPath);
          for (const item of native) {
            await item.manager.inspect();
            const candidate = await item.manager.preview(item.preferences.enabled);
            const current = await fileDigest(item.feature.targetFile);
            targets.push({
              target: item.feature.targetFile,
              title: item.feature.title,
              after: current === null && !item.preferences.enabled ? null : sha256(candidate),
            });
          }
          if (new Set(targets.map((item) => item.target)).size !== targets.length)
            throw new Error("多个功能共用快捷键文件，尚不支持完整快照安装；未写入。");
          await beginSnapshot(config.appPath, targets);
        } catch (error) {
          return {
            complete: false,
            restartRequired: false,
            nextStep: `${error instanceof Error ? error.message : String(error)} 未开始写入；处理后重新安装整个 App。`,
            steps: [
              {
                id: "preflight",
                title: "安装前重新检查",
                status: "failed",
                detail: error instanceof Error ? error.message : String(error),
              },
              ...stageNames.map((step) => ({ ...step, status: "skipped" as const, detail: "未执行。" })),
            ],
          };
        }
        const run = async (id: string, title: string, work: () => Promise<string>) => {
          if (steps.some((step) => step.status === "failed")) {
            steps.push({ id, title, status: "skipped", detail: "前一步失败，未执行。" });
            return;
          }
          try {
            steps.push({ id, title, status: "done", detail: await work() });
          } catch (error) {
            steps.push({
              id,
              title,
              status: "failed",
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        };
        for (const task of tasks)
          await run(task.id, task.title, async () => {
            const installed = await task.engine.apply(task.config);
            needsRestart ||= installed.changed;
            return installed.changed
              ? "已写入并验证资源，原始文件已备份。"
              : "资源代码相同，包内原文备份已就绪。";
          });
        for (const item of native)
          await run(`native:${item.feature.id}`, item.feature.title, async () => {
            const message = item.preferences.enabled
              ? await item.manager.install()
              : await item.manager.restore();
            const current = await item.manager.inspect();
            if (!item.preferences.enabled && current.enabled)
              throw new Error("用户自行配置的聚焦规则仍存在；没有删除用户规则。");
            try {
              await saveNativePreferences(item.data, item.preferences);
            } catch (error) {
              throw new Error(
                `快捷键规则已处理，但偏好保存失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return message;
          });
        await run("preferences", "记录 App 配置", async () => {
          await saveConfig(adapter, config, directory);
          return "已记录统一配置。";
        });
        if (steps.every((step) => step.status === "done"))
          await run("snapshot", "校验完整安装快照", () =>
            finishSnapshot(config.appPath).then(() => "首次备份与安装后摘要已记录。"),
          );
        const complete = steps.every((step) => step.status === "done");
        return {
          complete,
          steps,
          restartRequired: needsRestart,
          nextStep: complete
            ? needsRestart
              ? `整个 App 安装完成。请重新打开 ${adapter.title} 后验证已安装功能。`
              : requiresAppExit
                ? "App 配置与包内备份已就绪，请重新打开应用。"
                : "整个 App 配置已就绪；若先前安装后未重新打开，请重新打开。否则仅快捷键配置通常即时生效。"
            : "整个 App 安装未完成。已完成的步骤保留，备份也保留；请先 Restore 完整恢复，再 Install。",
        };
      });
    },
  };
}

/** Restore every owned App resource; keybinding preferences remain independently configured. */
export async function restoreAppResources(
  adapter: AppAdapter,
  appPath: string,
  directory = appDataDirectory(adapter.id),
) {
  const engines = resourceEngines(adapter, directory);
  const inspections = await Promise.all(engines.map((item) => item.inspect(appPath)));
  if (inspections.some((item) => item.backupState === "invalid"))
    throw new Error("恢复所需备份校验失败，未修改 App。请保留文件并检查。 ");
  if (inspections.some((item) => item.kind !== "original")) await requireAppClosed(appPath, adapter.title);
  for (const item of engines) await item.restore(appPath);
}

function resourceEngines(adapter: AppAdapter, directory: string): PatchEngine[] {
  return [
    ...(adapter.features.some((f) => f.kind === "resource" && !f.resourceTarget)
      ? [new PatchEngine(adapter, directory)]
      : []),
    ...companions(adapter, directory).map((item) => item.engine),
  ];
}

export async function adoptAppResources(
  adapter: AppAdapter,
  appPath: string,
  directory = appDataDirectory(adapter.id),
) {
  const engines = resourceEngines(adapter, directory);
  const inspections = await Promise.all(engines.map((engine) => engine.inspect(appPath)));
  if (inspections.some((item) => item.backupState === "invalid"))
    throw new Error("已有备份校验失败，未创建或覆盖备份。");
  if (inspections.some((item) => item.backupState === "missing" || item.backupLocation === "legacy-external"))
    await requireAppClosed(appPath, adapter.title);
  for (const engine of engines) await engine.adopt(appPath);
}

/** Read-only recovery preview, including provable legacy installations. */
export async function prepareAppRestore(
  adapter: AppAdapter,
  directory = appDataDirectory(adapter.id),
  suppliedPath?: string,
) {
  const appPath = suppliedPath ?? (await loadConfig(adapter, directory)).appPath;
  if (await hasSnapshot(appPath)) {
    const snapshot = await inspectSnapshotRestore(appPath);
    return {
      appPath,
      entries: snapshot.entries,
      legacy: false,
      execute: async (onStep: (title: string) => void) => {
        await requireAppClosed(appPath, adapter.title);
        return withSnapshotLock(appPath, async () => {
          await restoreSnapshot(appPath, onStep);
        });
      },
    };
  }
  const targets: import("./app-snapshot").LegacySnapshotTarget[] = [];
  for (const engine of resourceEngines(adapter, directory)) {
    const status = await engine.inspect(appPath);
    if (status.backupState === "invalid" || (status.kind !== "original" && status.backupState !== "valid"))
      throw new Error("旧版资源缺少可信原文备份，无法完整恢复。");
    targets.push({
      title: engine.adapter.title,
      target: status.artifactPath,
      after: status.digest,
      before: status.profile.originalSha256,
      original: status.kind === "original" ? status.artifactPath : status.backupPath,
    });
  }
  for (const feature of adapter.features)
    if (feature.kind === "ide-keybinding") {
      const manager = featureKeybindingInstaller(feature, path.join(directory, feature.dataSubdirectory));
      targets.push({ title: feature.title, target: feature.targetFile, ...(await manager.legacyBaseline()) });
    }
  if (new Set(targets.map((item) => item.target)).size !== targets.length)
    throw new Error("恢复目标重复，请检查配置。");
  return {
    appPath,
    entries: targets,
    legacy: true,
    execute: async (onStep: (title: string) => void) => {
      await requireAppClosed(appPath, adapter.title);
      return withSnapshotLock(appPath, async () => {
        await importLegacySnapshot(appPath, targets);
        await restoreSnapshot(appPath, onStep);
      });
    },
  };
}
