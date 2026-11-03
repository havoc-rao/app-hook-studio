import { Action, ActionPanel, Form, Icon, Toast, open, showToast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { AppAdapter } from "../core/contracts";
import {
  prepareAppInstall,
  appInstallRequirements,
  AppInstallPlan,
  AppInstallResult,
} from "../application/app-install";
import { APP_INSTALL_SHORTCUT } from "./shortcuts";

import { loadConfig } from "../core/storage";
import { AppVersionFields } from "./app-version";

export function InstallApp({ adapter, onChanged = () => {} }: { adapter: AppAdapter; onChanged?(): void }) {
  const [appPath, setAppPath] = useState<string>();
  const [plan, setPlan] = useState<AppInstallPlan>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<AppInstallResult>();
  const [revision, setRevision] = useState(0);
  const { pop } = useNavigation();
  const requirements = appInstallRequirements(adapter);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setPlan(undefined);
    setError("");
    setResult(undefined);
    loadConfig(adapter)
      .then((config) => {
        if (active) setAppPath(config.appPath);
        return prepareAppInstall(adapter);
      })
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [adapter, revision]);
  async function install() {
    if (!plan || installing || result?.complete) return;
    setInstalling(true);
    const toast = await showToast(Toast.Style.Animated, `安装 ${adapter.title}`);
    try {
      const value = await plan.execute();
      setResult(value);
      onChanged();
      toast.style = value.complete ? Toast.Style.Success : Toast.Style.Failure;
      toast.title = value.complete ? "App 安装完成" : "App 安装未完成";
      toast.message = value.steps.find((step) => step.status === "failed")?.detail ?? value.nextStep;
    } catch (reason) {
      toast.style = Toast.Style.Failure;
      toast.title = "App 安装未完成";
      toast.message = reason instanceof Error ? reason.message : String(reason);
      setError(toast.message);
    } finally {
      setInstalling(false);
    }
  }
  return (
    <Form
      navigationTitle={`Install · ${adapter.title}`}
      isLoading={loading || installing}
      actions={
        <ActionPanel>
          {result?.complete ? (
            <>
              <Action
                title={`打开 ${adapter.title}`}
                icon={Icon.AppWindow}
                onAction={() => open(plan!.appPath)}
              />
              <Action title="返回" icon={Icon.ArrowLeft} onAction={pop} />
            </>
          ) : (
            <>
              {plan && (
                <Action.SubmitForm
                  title={`Install / 安装 ${adapter.title}`}
                  icon={Icon.Download}
                  shortcut={APP_INSTALL_SHORTCUT}
                  onSubmit={install}
                />
              )}
              <Action
                title="重新检查"
                icon={Icon.ArrowClockwise}
                onAction={() => setRevision((value) => value + 1)}
              />
            </>
          )}
          <Action.OpenInBrowser
            title="查看 macOS 权限说明"
            url="https://support.apple.com/en-au/guide/mac-help/mchl211c911f/mac"
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="安装单位"
        text={`${adapter.title} 整体安装；功能页只保存配置。⌘Enter 打开此页，确认后再次 ⌘Enter 执行安装。`}
      />
      {appPath && <AppVersionFields adapter={adapter} appPath={appPath} />}
      <Form.Description title="支持版本要求" text={adapter.supportDescription} />
      {error && <Form.Description title="需要处理" text={error} />}
      {plan?.items.map((item) => (
        <Form.Description key={item.id} title={item.title} text={`${item.settings}\n${item.target}`} />
      ))}
      {plan?.backups.map((backup) => (
        <Form.Description
          key={backup.title}
          title={`原文件备份 · ${backup.title}`}
          text={`${backup.destination}${backup.migrationRequired ? `\n旧备份将复制迁移并保留：${backup.current}` : ""}`}
        />
      ))}
      <Form.Description
        title="恢复方式"
        text="从包内原文备份校验后覆盖回资源文件。备份目录保留；官方更新前先恢复或另存备份。用户快捷键记录仍在用户数据目录。"
      />
      <Form.Separator />
      <Form.Description title="所需权限" text={requirements.permission} />
      <Form.Description title="安装前" text={requirements.before} />
      <Form.Description title="安装后" text={result?.nextStep ?? requirements.after} />
      {plan && (
        <Form.Description
          title="本次重启要求"
          text={
            plan.restartRequired
              ? "应用资源将更新：安装前退出，完成后重新打开 App。"
              : plan.requiresAppExit
                ? "资源代码相同，但需创建/迁移包内备份；请先退出，完成后重新打开。"
                : "应用资源和包内备份均无需写入；仅配置更新通常即时生效。如先前安装后未重新打开，仍应重新打开。"
          }
        />
      )}
      {!result &&
        plan?.checks.map((check) => (
          <Form.Description key={check.id} title={check.label} text={check.detail} />
        ))}
      {result?.steps.map((step) => (
        <Form.Description
          key={step.id}
          title={step.title}
          text={`${step.status === "done" ? "已完成" : step.status === "failed" ? "失败" : "未执行"}：${step.detail}`}
        />
      ))}
    </Form>
  );
}
