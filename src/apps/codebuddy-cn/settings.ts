import { Settings } from "../../core/contracts";
import { parseShortcut } from "../../core/shortcuts";

export type CodeBuddySettings = Settings & {
  newChatEnabled: boolean;
  newChatShortcut: string;
  stopMode: "double-escape" | "shortcut" | "disabled";
  stopShortcut: string;
  doubleEscapeMs: number;
  scope: "panel" | "input";
};

export const DEFAULT_SETTINGS: CodeBuddySettings = {
  newChatEnabled: true,
  newChatShortcut: "ctrl+cmd+n",
  stopMode: "double-escape",
  stopShortcut: "cmd+alt+.",
  doubleEscapeMs: 500,
  scope: "panel",
};

export function validateSettings(value: unknown): CodeBuddySettings {
  if (!value || typeof value !== "object") throw new Error("配置必须是对象。");
  const v = value as Record<string, unknown>;
  if (
    typeof v.newChatEnabled !== "boolean" ||
    typeof v.newChatShortcut !== "string" ||
    typeof v.stopShortcut !== "string" ||
    !["double-escape", "shortcut", "disabled"].includes(String(v.stopMode)) ||
    !["panel", "input"].includes(String(v.scope)) ||
    typeof v.doubleEscapeMs !== "number" ||
    !Number.isSafeInteger(v.doubleEscapeMs) ||
    v.doubleEscapeMs <= 0
  ) {
    throw new Error("配置字段不完整，或双 Esc 间隔不是正整数（毫秒）。");
  }
  const config: CodeBuddySettings = {
    newChatEnabled: v.newChatEnabled,
    newChatShortcut: v.newChatShortcut.trim(),
    stopMode: v.stopMode as CodeBuddySettings["stopMode"],
    stopShortcut: v.stopShortcut.trim(),
    doubleEscapeMs: v.doubleEscapeMs,
    scope: v.scope as CodeBuddySettings["scope"],
  };
  const newChat = config.newChatEnabled ? parseShortcut(config.newChatShortcut) : undefined;
  const stop = config.stopMode === "shortcut" ? parseShortcut(config.stopShortcut) : undefined;
  if (newChat && !newChat.meta && !newChat.ctrl && !newChat.alt) {
    throw new Error("新建对话请至少使用 Cmd、Ctrl、Option 中的一个修饰键，避免输入文字时误触发。");
  }
  if (newChat && stop && JSON.stringify(newChat) === JSON.stringify(stop)) {
    throw new Error("新建对话与停止聊天不能使用相同快捷键。");
  }
  return config;
}
