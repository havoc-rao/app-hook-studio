export type SettingValue = string | number | boolean;
export type Settings = Record<string, SettingValue>;
export type AppConfig = { schema: 1; appId: string; appPath: string; settings: Settings };

export type SettingField = {
  id: string;
  title: string;
  info?: string;
  when?: { field: string; equals: SettingValue };
} & (
  | { type: "text" | "number"; placeholder?: string }
  | { type: "checkbox"; label: string }
  | { type: "select"; options: readonly { value: string; title: string }[] }
);

export type CommandArguments = { commands: readonly string[] };

export type AppFeature = {
  id: string;
  title: string;
  description: string;
  symbol: "plus" | "stop" | "focus";
} & (
  | {
      kind: "resource";
      fieldIds: readonly string[];
      enabledControl?: { field: string; disabled: SettingValue; enabled: SettingValue };
      summarize(settings: Settings): string;
    }
  | {
      kind: "ide-keybinding";
      defaultShortcut: string;
      command: string;
      commandArguments?: CommandArguments;
      targetFile: string;
      dataSubdirectory: string;
      verificationNote: string;
      previousCommands?: readonly string[];
      resourceBridge?: AppAdapter;
    }
);

export type ArtifactProfile = {
  id: string;
  label: string;
  artifactRelativePath: string;
  originalSha256: string;
};
export type PatchAnalysis = {
  kind: "original" | "legacy" | "managed";
  original: string;
  installedSettings?: Settings;
  upgradeRequired?: boolean;
};

/** Packaged adapters own target facts; the engine owns file writes and recovery. UTF-8 resources only. */
export type AppVersion = { app: string; components: Record<string, string> };

export type AppAdapter = {
  id: string;
  title: string;
  description: string;
  supportDescription: string;
  defaultAppPath: string;
  versions?: { supported: AppVersion; read(appPath: string): Promise<AppVersion> };
  resourceProcessing?: "node-process";
  defaultSettings: Settings;
  fields: readonly SettingField[];
  features: readonly AppFeature[];
  validateSettings(value: unknown): Settings;
  summarize(settings: Settings): string;
  identify(appPath: string): Promise<ArtifactProfile>;
  analyze(source: string, profile: ArtifactProfile): PatchAnalysis;
  patch(original: string, settings: Settings, profile: ArtifactProfile): string;
  /** Parse or validate the complete candidate resource without executing target code. */
  verifyPatch(source: string, profile: ArtifactProfile): string;
  maintenanceActions?: readonly {
    id: string;
    title: string;
    run(context: { appPath: string; dataDirectory: string }): Promise<string>;
  }[];
  legacyConfig?: {
    path: string;
    decode(value: unknown): { appPath: string; settings: Settings };
  };
};

export function defaultConfig(adapter: AppAdapter): AppConfig {
  return {
    schema: 1,
    appId: adapter.id,
    appPath: adapter.defaultAppPath,
    settings: { ...adapter.defaultSettings },
  };
}

export function validateAppConfig(adapter: AppAdapter, value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("应用配置必须是对象。");
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || v.appId !== adapter.id || typeof v.appPath !== "string" || !v.appPath.trim()) {
    throw new Error(`配置不属于所选应用 ${adapter.id}，或缺少应用路径。`);
  }
  return {
    schema: 1,
    appId: adapter.id,
    appPath: v.appPath.trim(),
    settings: adapter.validateSettings(v.settings),
  };
}
