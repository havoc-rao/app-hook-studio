import { Action, ActionPanel, Form, Icon, Toast, open, showToast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { promises as fs } from "node:fs";
import { AppAdapter } from "../core/contracts";
import { PatchEngine, PreflightReport, expandAppPath } from "../core/engine";
import { SaveAndInstallAppAction } from "./install-action";
import { ENTER_SHORTCUT } from "./shortcuts";
import { loadConfig, saveConfig } from "../core/storage";

import { restoreAppResources } from "../application/app-install";
import { AppVersionFields } from "./app-version";

export function ConfigureApplication({ adapter, onChanged }: { adapter: AppAdapter; onChanged(): void }) {
  const engine = useMemo(() => new PatchEngine(adapter), [adapter]);
  const [appPath, setAppPath] = useState(adapter.defaultAppPath);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PreflightReport>();
  useEffect(() => {
    let active = true;
    loadConfig(adapter)
      .then((config) => {
        if (active) setAppPath(config.appPath);
      })
      .catch((error: unknown) => void showToast(Toast.Style.Failure, "读取配置失败", String(error)));
    return () => {
      active = false;
    };
  }, [adapter]);
  async function savePath() {
    const latest = await loadConfig(adapter);
    await saveConfig(adapter, { ...latest, appPath: expandAppPath(appPath) });
  }
  async function task(title: string, work: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    const toast = await showToast(Toast.Style.Animated, title);
    try {
      toast.message = await work();
      toast.style = Toast.Style.Success;
      toast.title = "完成";
      onChanged();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "操作失败";
      toast.message = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle={`${adapter.title} · 应用管理`}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存应用路径"
            shortcut={ENTER_SHORTCUT}
            icon={Icon.SaveDocument}
            onSubmit={() =>
              task("保存路径", async () => {
                await savePath();
                return "路径已保存，功能配置保持原样。";
              })
            }
          />
          <SaveAndInstallAppAction adapter={adapter} save={savePath} onChanged={onChanged} />
          <Action
            title="检查资源补丁兼容性"
            icon={Icon.MagnifyingGlass}
            onAction={() =>
              task("预检查", async () => {
                const latest = await loadConfig(adapter);
                const result = await engine.preflight({ ...latest, appPath });
                setReport(result);
                if (!result.compatible)
                  throw new Error(result.checks.find((check) => check.status === "fail")?.detail ?? "未通过");
                return "静态检查通过，未写入应用。";
              })
            }
          />
          <Action
            title="备份并接管现有资源补丁"
            icon={Icon.HardDrive}
            onAction={() =>
              task("备份", async () => {
                await engine.adopt(appPath);
                return "已保存原始备份。";
              })
            }
          />
          <Action
            title="恢复整个资源补丁"
            icon={Icon.Undo}
            onAction={() =>
              task("恢复", async () => {
                await restoreAppResources(adapter, appPath);
                return "原始资源已恢复；重新打开应用生效。";
              })
            }
          />
          <Action
            title="打开数据目录"
            icon={Icon.Folder}
            onAction={() =>
              task("打开目录", async () => {
                await fs.mkdir(engine.dataDirectory, { recursive: true, mode: 0o700 });
                await open(engine.dataDirectory);
                return "已打开。";
              })
            }
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="appPath"
        title="应用路径"
        value={appPath}
        onChange={(value) => {
          setAppPath(value);
          setReport(undefined);
        }}
      />
      <AppVersionFields adapter={adapter} appPath={expandAppPath(appPath)} />
      <Form.Description title="支持范围" text={adapter.supportDescription} />
      <Form.Description
        title="恢复范围"
        text="恢复整个资源补丁会移除该资源上的所有注入功能，包含聚焦命令桥接；不改变用户快捷键配置。恢复后新聚焦命令不可用，需重新整体安装。恢复前请退出应用。"
      />
      <Form.Description
        title="写入权限"
        text="修改应用包需要执行端的“App 管理”权限。静态预检查不代表功能已通过真实会话验证。"
      />
      {report?.checks.map((check) => (
        <Form.Description
          key={check.id}
          title={check.label}
          text={`${check.status === "pass" ? "通过" : "失败"}：${check.detail}`}
        />
      ))}
    </Form>
  );
}
