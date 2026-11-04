import { renderApprovalHook } from "./approval-runtime";
import { assertSymbolExport } from "./bundle-contract";
import { FOCUS_BINDINGS } from "./focus-bindings";
import { renderFocusHostV1 } from "./focus-host-runtime-v1";
import { Script } from "node:vm";
import { AppAdapter } from "../../core/contracts";
import { sha256 } from "../../core/hash";
import { PROFILE } from "./profile";
import { readCodebuddyVersion } from "./version";
import { renderFocusHost } from "./focus-host-runtime";
export { FOCUS_COMMAND } from "./focus-protocol";
export const HOST_PROFILE = {
  id: "codebuddy-cn-focus-host-genie-3-10-0",
  artifactRelativePath: "Contents/Resources/app/extensions/genie/out/extension/index.js",
  originalSha256: "f99b6e1e25e62b442bc7335b67e859f80c3b6d6a1c51d31cfb52591c578aa42e",
  anchor: "}async function doActivate(ir,ar){",
};
const V1_BEGIN = "/* APP_HOOK_STUDIO_FOCUS_HOST v1 */\n";
const V2_BEGIN = "/* APP_HOOK_STUDIO_FOCUS_HOST v2 */\n";
const BEGIN = "/* APP_HOOK_STUDIO_FOCUS_HOST v3 */\n",
  END = "/* APP_HOOK_STUDIO_FOCUS_HOST_END */\n";
const block = () => BEGIN + renderFocusHost() + renderApprovalHook() + END;
function analyze(source: string) {
  if (sha256(source) === HOST_PROFILE.originalSha256) return { kind: "original" as const, original: source };
  const v1 = source.includes(V1_BEGIN);
  const v2 = source.includes(V2_BEGIN);
  const marker = v1 ? V1_BEGIN : v2 ? V2_BEGIN : BEGIN;
  const expected = v1
    ? V1_BEGIN + renderFocusHostV1() + END
    : v2
      ? V2_BEGIN + renderFocusHost() + END
      : block();
  const at = source.indexOf(marker),
    end = source.indexOf(END, at);
  if (
    at < 0 ||
    end < at ||
    source.indexOf(marker, at + marker.length) >= 0 ||
    source.slice(at, end + END.length) !== expected
  )
    throw new Error("聚焦命令桥接资源未知或被修改，拒绝覆盖。");
  const original = source.slice(0, at) + source.slice(end + END.length);
  if (sha256(original) !== HOST_PROFILE.originalSha256 || original.indexOf(HOST_PROFILE.anchor) !== at)
    throw new Error("聚焦命令桥接原文摘要或位置不匹配。");
  return { kind: "managed" as const, original, installedSettings: {}, upgradeRequired: v1 || v2 };
}
export const focusHostAdapter: AppAdapter = {
  id: "codebuddy-cn-focus-host",
  title: "CodeBuddy 聚焦与批准通知桥接",
  description: "输入框聚焦命令及 Notification / permission_prompt 批准通知",
  supportDescription: "CodeBuddy 1.106.1 / genie 3.10.0，校验扩展主文件摘要。",
  defaultAppPath: "/Applications/CodeBuddy CN.app",
  resourceProcessing: "node-process",
  defaultSettings: {},
  fields: [],
  features: [],
  validateSettings(value) {
    if (!value || typeof value !== "object" || Object.keys(value).length)
      throw new Error("聚焦桥接无独立设置。");
    return {};
  },
  summarize: () => "聚焦命令桥接",
  async identify(appPath) {
    const version = await readCodebuddyVersion(appPath);
    if (version.app !== PROFILE.appVersion || version.components.genie !== PROFILE.extensionVersion)
      throw new Error("聚焦桥接不支持当前 App / genie 版本。");
    return { ...HOST_PROFILE, label: `CodeBuddy ${version.app} / genie ${version.components.genie}` };
  },
  analyze,
  patch(original) {
    if (sha256(original) !== HOST_PROFILE.originalSha256 || original.split(HOST_PROFILE.anchor).length !== 2)
      throw new Error("聚焦命令桥接源文或锚点不匹配。");
    return original.replace(HOST_PROFILE.anchor, block() + HOST_PROFILE.anchor);
  },
  verifyPatch(source) {
    assertSymbolExport(source, 946785, "HookManager");
    assertSymbolExport(source, 155735, "HistoryService");
    assertSymbolExport(source, FOCUS_BINDINGS.provider, "ActivityBarChatWebviewProvider");
    assertSymbolExport(source, FOCUS_BINDINGS.chatView, "ChatViewService");
    new Script(source);
    return "扩展服务导出契约与完整语法解析通过，未执行目标代码。";
  },
};
