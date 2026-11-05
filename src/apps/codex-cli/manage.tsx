import { Action, ActionPanel, Color, Detail, Icon, environment, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { codexIntegrationStatus, installCodexIntegration, uninstallCodexIntegration } from "./service";
import { REFRESH_SHORTCUT } from "../../ui/shortcuts";

export default function CodexIntegration() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof codexIntegrationStatus>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try {
      setStatus(await codexIntegrationStatus());
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const run = async (install: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(
        await (install ? installCodexIntegration(environment.assetsPath) : uninstallCodexIntegration()),
      );
      setError("");
      await showToast({
        style: Toast.Style.Success,
        title: install ? "Codex 接入规则已安装" : "Codex 接入规则已移除",
        message: "新终端生效；已有终端请重新加载 shell 配置。",
      });
    } catch (e) {
      setError(String(e));
      await showToast({
        style: Toast.Style.Failure,
        title: install ? "安装失败" : "恢复失败",
        message: String(e),
      });
    } finally {
      setBusy(false);
    }
  };
  const markdown = `# Codex CLI

终端原生审批，与 CoLink 同步接入。

${error ? `## 操作未完成\n\n${error}\n\n` : ""}## ${loading ? "正在检查接入状态…" : status?.installed ? "已启用双入口审批" : status ? "连接你的终端工作流" : "暂时无法读取状态"}

在终端运行 \`codex\`，保留原生交互和审批，同时通过 CoLink 处理批准请求。

### 接入后如何使用

1. 安装启动规则后，打开一个新终端。
2. 运行 \`codex\`，开始交互会话。
3. 在终端或 CoLink 中处理审批。

### 安装与恢复

安装会备份并更新 zsh 配置，部署本机代理。已有终端需重新加载 shell 配置。

\`exec\`、登录和更新命令直接使用官方 CLI。

恢复会移除本工具的启动规则，并保留备份和运行时供已有会话使用。新终端恢复原始 \`codex\`；已有终端可执行 \`unfunction codex\`。`;
  return (
    <Detail
      navigationTitle="Codex CLI"
      isLoading={loading || busy}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="应用" text="Codex CLI" icon="chatgpt.png" />
          <Detail.Metadata.TagList title="接入状态">
            <Detail.Metadata.TagList.Item
              text={loading ? "检查中" : status ? (status.installed ? "已安装" : "未安装") : "读取失败"}
              color={status?.installed ? Color.Green : Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="审批入口" text="终端 · CoLink" />
          {status?.version && <Detail.Metadata.Label title="安装时版本" text={status.version} />}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Shell 配置" text={status?.shellFile || "—"} />
          <Detail.Metadata.Label title="官方程序" text={status?.official || "/opt/homebrew/bin/codex"} />
          <Detail.Metadata.Label title="代理运行时" text={status?.runtimeDirectory || "—"} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="接入管理">
            <Action
              title={status?.installed ? "更新接入规则" : "安装接入规则"}
              icon={Icon.Download}
              shortcut={{ modifiers: ["cmd"], key: "return" }}
              onAction={() => run(true)}
            />
            <Action
              title="刷新状态"
              icon={Icon.ArrowClockwise}
              shortcut={REFRESH_SHORTCUT}
              onAction={refresh}
            />
          </ActionPanel.Section>
          {status?.installed && (
            <ActionPanel.Section title="恢复">
              <Action title="移除接入规则" icon={Icon.ArrowCounterClockwise} onAction={() => run(false)} />
            </ActionPanel.Section>
          )}
        </ActionPanel>
      }
    />
  );
}
