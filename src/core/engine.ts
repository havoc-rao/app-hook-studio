import { resourceOperation } from "./resource-worker";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import path from "node:path";
import { homedir } from "node:os";
import { AppAdapter, AppConfig, PatchAnalysis, ArtifactProfile, validateAppConfig } from "./contracts";
import { sha256 } from "./hash";
import { appDataDirectory, isMissing, writeAtomic } from "./storage";

const execFileAsync = promisify(execFile);
export type Inspection = {
  appId: string;
  appPath: string;
  artifactPath: string;
  profile: ArtifactProfile;
  digest: string;
  kind: PatchAnalysis["kind"];
  upgradeRequired: boolean;
  installedConfig?: AppConfig;
  backupPath: string;
  backupDestinationPath: string;
  backupLocation: "inside-app" | "legacy-external";
  backupState: "missing" | "valid" | "invalid";
};

export type PreflightCheck = { id: string; label: string; status: "pass" | "fail"; detail: string };
export type PreflightReport =
  | {
      compatible: true;
      checks: PreflightCheck[];
      inspection: Inspection;
      candidateSha256: string;
      willChange: boolean;
      willWriteBackup: boolean;
    }
  | { compatible: false; checks: PreflightCheck[] };

type CurrentArtifact = {
  appPath: string;
  artifactPath: string;
  profile: ArtifactProfile;
  source: string;
} & PatchAnalysis;

class PreflightError extends Error {
  constructor(
    readonly checks: PreflightCheck[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function expandAppPath(input: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input;
  if (!path.isAbsolute(expanded) || path.extname(expanded) !== ".app") {
    throw new Error("请选择绝对路径的 .app 应用包（支持 ~/ 开头）。");
  }
  return path.resolve(expanded);
}

export const appBackupRoot = (appPath: string): string =>
  path.join(appPath, "Contents/Resources/app-hook-studio-backups");

export class PatchEngine {
  readonly dataDirectory: string;
  constructor(
    readonly adapter: AppAdapter,
    dataDirectory?: string,
    private readonly options: { inline?: boolean } = {},
  ) {
    this.dataDirectory = dataDirectory ?? appDataDirectory(adapter.id);
  }

  private async read(appPath: string): Promise<CurrentArtifact> {
    const resolved = await fs.realpath(expandAppPath(appPath));
    const profile = await this.adapter.identify(resolved);
    const artifactPath = path.join(resolved, profile.artifactRelativePath);
    const source = await fs.readFile(artifactPath, "utf8");
    const analysis = this.adapter.analyze(source, profile);
    // The core checks original identity independently of adapter-specific patch ownership.
    if (sha256(analysis.original) !== profile.originalSha256)
      throw new Error("Adapter 返回的原始资源摘要与 profile 不符。");
    return { appPath: resolved, artifactPath, profile, source, ...analysis };
  }

  async inspect(appPath: string): Promise<Inspection> {
    if (this.adapter.resourceProcessing === "node-process" && !this.options.inline)
      return resourceOperation(this.adapter.id, "inspect", this.dataDirectory, appPath);
    return this.describe(await this.read(appPath));
  }

  private async describe(current: CurrentArtifact): Promise<Inspection> {
    const backupDestinationPath = this.backupPath(current.appPath, current.profile);
    const legacyPath = path.join(this.dataDirectory, "backups", `${current.profile.originalSha256}.original`);
    let backupPath = backupDestinationPath;
    let backupLocation: Inspection["backupLocation"] = "inside-app";
    let backupState: Inspection["backupState"] = "missing";
    for (const candidate of [backupDestinationPath, legacyPath]) {
      try {
        const bytes = await fs.readFile(candidate);
        backupPath = candidate;
        backupLocation = candidate === backupDestinationPath ? "inside-app" : "legacy-external";
        backupState = sha256(bytes) === current.profile.originalSha256 ? "valid" : "invalid";
        break; // A corrupt primary backup is never hidden by a valid legacy copy.
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return {
      appId: this.adapter.id,
      appPath: current.appPath,
      artifactPath: current.artifactPath,
      profile: current.profile,
      digest: sha256(current.source),
      kind: current.kind,
      upgradeRequired: current.kind === "legacy" || current.upgradeRequired === true,
      installedConfig: current.installedSettings
        ? {
            schema: 1,
            appId: this.adapter.id,
            appPath: current.appPath,
            settings: current.installedSettings,
          }
        : undefined,
      backupPath,
      backupDestinationPath,
      backupLocation,
      backupState,
    };
  }

  private backupPath(appPath: string, profile: ArtifactProfile): string {
    return path.join(appBackupRoot(appPath), this.adapter.id, `${profile.originalSha256}.original`);
  }

  private async preserveOriginal(current: CurrentArtifact): Promise<void> {
    const { original, profile } = current;
    const status = await this.describe(current);
    if (status.backupState === "invalid")
      throw new Error("已有备份摘要不匹配；保留现场，拒绝覆盖备份或修改应用。");
    if (status.backupState === "valid" && status.backupLocation === "inside-app") return;
    const backup = this.backupPath(current.appPath, profile);
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    try {
      if (sha256(await fs.readFile(backup)) !== profile.originalSha256) {
        throw new Error("已有备份摘要不匹配；保留现场，拒绝覆盖备份或修改应用。");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      const handle = await fs.open(backup, "wx", 0o600);
      try {
        await handle.writeFile(original);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private async replace(artifactPath: string, expected: string, replacement: string): Promise<void> {
    if (sha256(await fs.readFile(artifactPath)) !== sha256(expected)) {
      throw new Error("检测后应用文件发生变化；未覆盖，请重新检测。");
    }
    const stat = await fs.stat(artifactPath);
    try {
      await writeAtomic(artifactPath, replacement, stat.mode & 0o777);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EPERM" || code === "EACCES") {
        throw new Error(
          "macOS 拒绝修改应用包。请在 系统设置 → 隐私与安全性 → App 管理 中允许当前执行端（Raycast 或终端），重新打开执行端后重试。原始备份已保留；不会自动提权或修改系统保护。",
        );
      }
      throw error;
    }
    if (sha256(await fs.readFile(artifactPath)) !== sha256(replacement)) {
      throw new Error("写入后的摘要校验失败。请保留备份并重新检查应用状态。");
    }
  }

  private async prepare(value: unknown) {
    const checks: PreflightCheck[] = [];
    const check = async <T>(
      id: string,
      label: string,
      perform: () => T | Promise<T>,
      detail: (value: T) => string,
    ): Promise<T> => {
      try {
        const result = await perform();
        checks.push({ id, label, status: "pass", detail: detail(result) });
        return result;
      } catch (error) {
        checks.push({
          id,
          label,
          status: "fail",
          detail: error instanceof Error ? error.message : String(error),
        });
        throw new PreflightError(checks, error);
      }
    };
    const config = await check(
      "configuration",
      "配置与应用 ID",
      () => validateAppConfig(this.adapter, value),
      () => "配置字段有效，属于当前应用。",
    );
    const current = await check(
      "artifact",
      "构建与资源身份",
      () => this.read(config.appPath),
      (artifact) => `${artifact.profile.label}；资源与已验证构建匹配。`,
    );
    const patched = await check(
      "patch-contract",
      "插入位置与补丁契约",
      () => {
        const candidate = this.adapter.patch(current.original, config.settings, current.profile);
        const produced = this.adapter.analyze(candidate, current.profile);
        if (
          produced.kind !== "managed" ||
          produced.original !== current.original ||
          !isDeepStrictEqual(produced.installedSettings, config.settings)
        ) {
          throw new Error("生成补丁未通过 adapter 契约验证，未修改应用。");
        }
        return candidate;
      },
      () => "可生成并识别补丁，剥离后原文一致，嵌入设置与本次配置一致。",
    );
    await check(
      "static-validation",
      "完整资源静态验证",
      () => this.adapter.verifyPatch(patched, current.profile),
      (detail) => detail,
    );
    const inspection = await check(
      "backup",
      "已有备份状态",
      async () => {
        const result = await this.describe(current);
        if (result.backupState === "invalid") throw new Error("已有备份摘要不匹配；拒绝覆盖备份或修改应用。");
        return result;
      },
      (result) =>
        result.backupState === "valid"
          ? result.backupLocation === "inside-app"
            ? `包内原始备份有效：${result.backupPath}`
            : `旧备份有效：${result.backupPath}；安装时复制到 ${result.backupDestinationPath}，保留旧副本。`
          : `尚无备份；写入前先保存到 ${result.backupDestinationPath}。`,
    );
    return { config, current, patched, inspection, checks };
  }

  /** No backup, settings or application writes; does not execute the generated code. */
  async preflight(value: unknown): Promise<PreflightReport> {
    if (this.adapter.resourceProcessing === "node-process" && !this.options.inline)
      return resourceOperation(this.adapter.id, "preflight", this.dataDirectory, value);
    try {
      const prepared = await this.prepare(value);
      return {
        compatible: true,
        checks: prepared.checks,
        inspection: prepared.inspection,
        candidateSha256: sha256(prepared.patched),
        willChange: prepared.current.source !== prepared.patched,
        willWriteBackup:
          prepared.inspection.backupState === "missing" ||
          prepared.inspection.backupLocation === "legacy-external",
      };
    } catch (error) {
      if (error instanceof PreflightError) return { compatible: false, checks: error.checks };
      throw error;
    }
  }

  async apply(value: AppConfig): Promise<{ changed: boolean; inspection: Inspection }> {
    if (this.adapter.resourceProcessing === "node-process" && !this.options.inline)
      return resourceOperation(this.adapter.id, "apply", this.dataDirectory, value);
    // Always prepare fresh; a previously displayed preflight report is never write authority.
    const { config, current, patched, inspection } = await this.prepare(value);
    const changed = current.source !== patched;
    if (changed || inspection.backupState === "missing" || inspection.backupLocation === "legacy-external")
      await requireAppClosed(current.appPath, this.adapter.title);
    await this.preserveOriginal(current);
    if (changed) await this.replace(current.artifactPath, current.source, patched);
    return { changed, inspection: await this.inspect(config.appPath) };
  }

  async restore(appPath: string): Promise<{ changed: boolean; inspection: Inspection }> {
    if (this.adapter.resourceProcessing === "node-process" && !this.options.inline)
      return resourceOperation(this.adapter.id, "restore", this.dataDirectory, appPath);
    const current = await this.read(appPath);
    if (current.kind !== "original") {
      await requireAppClosed(current.appPath, this.adapter.title);
      await this.preserveOriginal(current);
      const backup = await fs.readFile(this.backupPath(current.appPath, current.profile), "utf8");
      await this.replace(current.artifactPath, current.source, backup);
    }
    return { changed: current.kind !== "original", inspection: await this.inspect(appPath) };
  }

  async adopt(appPath: string): Promise<Inspection> {
    if (this.adapter.resourceProcessing === "node-process" && !this.options.inline)
      return resourceOperation(this.adapter.id, "adopt", this.dataDirectory, appPath);
    const current = await this.read(appPath);
    const status = await this.describe(current);
    if (status.backupState === "invalid") throw new Error("已有备份摘要不匹配；拒绝覆盖。");
    if (status.backupState === "missing" || status.backupLocation === "legacy-external")
      await requireAppClosed(current.appPath, this.adapter.title);
    await this.preserveOriginal(current);
    return this.inspect(appPath);
  }
}

export async function requireAppClosed(appPath: string, title: string): Promise<void> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const prefix = path.join(appPath, "Contents/MacOS") + path.sep;
  if (stdout.split("\n").some((line) => line.trimStart().startsWith(prefix))) {
    throw new Error(`请先用 ⌘Q 完全退出 ${title}，再应用或恢复。不会自动终止应用或任务。`);
  }
}
