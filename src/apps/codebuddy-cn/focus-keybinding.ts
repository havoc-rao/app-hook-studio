import path from "node:path";
import { homedir } from "node:os";
import { AppFeature } from "../../core/contracts";
import { focusHostAdapter, FOCUS_COMMAND } from "./focus-host";

export const FOCUS_INPUT_BINDING = {
  key: "cmd+i",
  command: "runCommands",
  args: { commands: [FOCUS_COMMAND] },
};
export const CODEBUDDY_KEYBINDINGS = path.join(
  homedir(),
  "Library/Application Support/CodeBuddy CN/User/keybindings.json",
);
export const FOCUS_FEATURE: Extract<AppFeature, { kind: "ide-keybinding" }> = {
  id: "focus-input",
  title: "聚焦输入框",
  description: "⌘I · CodeBuddy 窗口内全局",
  symbol: "focus",
  kind: "ide-keybinding",
  defaultShortcut: "cmd+i",
  command: FOCUS_INPUT_BINDING.command,
  commandArguments: FOCUS_INPUT_BINDING.args,
  targetFile: CODEBUDDY_KEYBINDINGS,
  dataSubdirectory: "focus-keybinding",
  previousCommands: ["coding-copilot.webviews.chat.focus"],
  resourceBridge: focusHostAdapter,
  verificationNote:
    "专用命令打开聊天视图后，向输入框发出聚焦请求并等待焦点确认。需要整体安装并重启 CodeBuddy；作用域为 App 窗口内，包含编辑器和终端。真实 UI 仍需验收。",
};
