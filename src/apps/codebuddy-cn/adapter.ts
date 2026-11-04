import { readCodebuddyVersion } from "./version";
import { Script } from "node:vm";
import { homedir } from "node:os";
import path from "node:path";
import { AppAdapter } from "../../core/contracts";
import { DEFAULT_SETTINGS, validateSettings } from "./settings";
import { analyzeBundle, patchBundle } from "./hook";
import { PROFILE } from "./profile";
import { focusHostAdapter } from "./focus-host";
import { FOCUS_FEATURE } from "./focus-keybinding";

export const codebuddyAdapter: AppAdapter = {
  id: "codebuddy-cn",
  title: "CodeBuddy CN",
  description: "新建对话、停止聊天、聚焦输入框、工具批准通知",
  supportDescription: "支持已验证的 CodeBuddy 1.106.1 / genie 3.10.0 构建，同时校验原始资源摘要。",
  defaultAppPath: "/Applications/CodeBuddy CN.app",
  versions: {
    supported: { app: PROFILE.appVersion, components: { genie: PROFILE.extensionVersion } },
    read: readCodebuddyVersion,
  },
  defaultSettings: DEFAULT_SETTINGS,
  fields: [
    { id: "newChatEnabled", type: "checkbox", title: "启用", label: "安装时启用新建对话快捷键" },
    {
      id: "newChatShortcut",
      type: "text",
      title: "新建快捷键",
      info: "使用 + 连接，例如 ctrl+cmd+n。按物理按键识别。",
      when: { field: "newChatEnabled", equals: true },
    },
    {
      id: "stopMode",
      type: "select",
      title: "停止聊天",
      options: [
        { value: "double-escape", title: "连续按两次 Esc" },
        { value: "shortcut", title: "自定义组合键" },
        { value: "disabled", title: "禁用停止快捷键" },
      ],
    },
    {
      id: "doubleEscapeMs",
      type: "number",
      title: "双 Esc 间隔（毫秒）",
      info: "默认 500。按住 Esc 不算第二次；切换焦点或按其他键会重置。",
      when: { field: "stopMode", equals: "double-escape" },
    },
    {
      id: "stopShortcut",
      type: "text",
      title: "停止快捷键",
      placeholder: "cmd+alt+.",
      when: { field: "stopMode", equals: "shortcut" },
    },
    {
      id: "scope",
      type: "select",
      title: "生效范围",
      options: [
        { value: "panel", title: "聊天面板" },
        { value: "input", title: "仅聊天输入区域" },
      ],
    },
  ],
  features: [
    {
      id: "new-chat",
      title: "新建对话",
      description: "用快捷键开始新的对话",
      symbol: "plus",
      kind: "resource",
      enabledControl: { field: "newChatEnabled", disabled: false, enabled: true },
      fieldIds: ["newChatEnabled", "newChatShortcut", "scope"],
      summarize: (settings) => (settings.newChatEnabled ? String(settings.newChatShortcut) : "已关闭"),
    },
    {
      id: "stop-chat",
      title: "停止聊天",
      description: "停止当前生成，保留原取消流程",
      symbol: "stop",
      kind: "resource",
      enabledControl: { field: "stopMode", disabled: "disabled", enabled: "double-escape" },
      fieldIds: ["stopMode", "doubleEscapeMs", "stopShortcut", "scope"],
      summarize: (settings) =>
        settings.stopMode === "double-escape"
          ? `Esc → Esc · ${settings.doubleEscapeMs}ms`
          : settings.stopMode === "shortcut"
            ? String(settings.stopShortcut)
            : "已关闭",
    },
    FOCUS_FEATURE,
    {
      id: "approval-notification",
      title: "工具批准通知",
      description: "等待用户批准时执行 CodeBuddy 的 Notification / permission_prompt hooks",
      symbol: "notification",
      kind: "resource",
      fieldIds: [],
      resourceTarget: { adapter: focusHostAdapter, dataSubdirectory: "focus-keybinding/bridge" },
      summarize: () => "按 CodeBuddy Notification hooks 配置执行",
    },
  ],
  validateSettings,
  summarize(value) {
    const settings = validateSettings(value);
    const start = settings.newChatEnabled ? settings.newChatShortcut : "新建已禁用";
    const stop =
      settings.stopMode === "double-escape"
        ? `Esc → Esc（${settings.doubleEscapeMs}ms）`
        : settings.stopMode === "shortcut"
          ? settings.stopShortcut
          : "停止已禁用";
    return `${start} · ${stop}`;
  },
  async identify(appPath) {
    const {
      app: appVersion,
      components: { genie: extensionVersion },
    } = await readCodebuddyVersion(appPath);
    if (appVersion !== PROFILE.appVersion || extensionVersion !== PROFILE.extensionVersion) {
      throw new Error(
        `尚不支持 CodeBuddy ${String(appVersion)} / genie ${String(extensionVersion)}。${this.supportDescription}`,
      );
    }
    return {
      id: PROFILE.id,
      label: `CodeBuddy ${PROFILE.appVersion} / genie ${PROFILE.extensionVersion}`,
      artifactRelativePath: PROFILE.bundleRelativePath,
      originalSha256: PROFILE.originalSha256,
    };
  },
  analyze: (source) => analyzeBundle(source),
  patch: (original, settings) => patchBundle(original, validateSettings(settings)),
  verifyPatch(source, profile) {
    new Script(source, { filename: profile.artifactRelativePath });
    return "完整 JavaScript 语法解析通过；未执行目标代码。";
  },
  legacyConfig: {
    path: path.join(homedir(), "Library/Application Support/CodeBuddy Hotkeys/settings.json"),
    decode(value) {
      const v = value as Record<string, unknown>;
      if (!v || v.schema !== 1 || typeof v.appPath !== "string" || !v.appPath.trim())
        throw new Error("旧 CodeBuddy 配置格式异常。");
      return { appPath: v.appPath, settings: validateSettings(v) };
    },
  },
};
