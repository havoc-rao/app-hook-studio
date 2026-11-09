import { RestoreAppAction } from "./restore-app";
import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import path from "node:path";
import { AppAdapter, AppFeature } from "../core/contracts";
import { loadConfig, saveConfig, appDataDirectory } from "../core/storage";
import { PatchEngine } from "../core/engine";
import { featureKeybindingInstaller } from "../installers/ide-keybinding";
import { ConfigureResourceFeature } from "./configure-resource-feature";
import { ConfigureNativeFeature } from "./configure-native-feature";
import { InstallApp } from "./install-app";
import { RemoteInstallAction } from "./remote-install";
import { ENTER_SHORTCUT, APP_INSTALL_SHORTCUT, ADD_ENTRY_SHORTCUT } from "./shortcuts";
import {
  featureResourceEngine,
  loadNativePreferences,
  saveNativePreferences,
} from "../application/app-install";
import { AddEntry, DraftEntries } from "./add-entry";
import { ConfigureApplication } from "./configure-application";

type FeatureStatus = { summary: string; installation: "已安装" | "待安装" | "需检查" };

export function AppFeatures({ adapter }: { adapter: AppAdapter }) {
  const [labels, setLabels] = useState<Record<string, FeatureStatus>>({});
  const [enabledStates, setEnabledStates] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  const [saving, setSaving] = useState(false);
  async function toggleFeature(feature: AppFeature) {
    if (saving) return;
    setSaving(true);
    try {
      let enabled: boolean;
      if (feature.kind === "resource") {
        const control = feature.enabledControl;
        if (!control) return;
        const config = await loadConfig(adapter);
        enabled = config.settings[control.field] === control.disabled;
        await saveConfig(adapter, {
          ...config,
          settings: { ...config.settings, [control.field]: enabled ? control.enabled : control.disabled },
        });
      } else {
        const directory = path.join(appDataDirectory(adapter.id), feature.dataSubdirectory);
        const preferences = await loadNativePreferences(feature, directory);
        enabled = !preferences.enabled;
        await saveNativePreferences(directory, { ...preferences, enabled });
      }
      setEnabledStates((current) => ({ ...current, [feature.id]: enabled }));
      refresh();
      await showToast(
        Toast.Style.Success,
        `已保存：${enabled ? "启用" : "关闭"}${feature.title}`,
        "请执行 App 统一安装，使变更生效（⌘Enter）。",
      );
    } catch (reason) {
      await showToast(
        Toast.Style.Failure,
        "保存失败",
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    let active = true;
    (async () => {
      const saved = await loadConfig(adapter);
      let installed = saved.settings;
      let applied = false;
      try {
        const status = await new PatchEngine(adapter).inspect(saved.appPath);
        applied = !!status.installedConfig && !status.upgradeRequired;
        installed = status.installedConfig?.settings ?? saved.settings;
      } catch {
        /* Unverified build: show saved configuration, without an applied claim. */
      }
      const enabled: Record<string, boolean> = {};
      const entries = await Promise.all(
        adapter.features.map(async (feature): Promise<[string, FeatureStatus]> => {
          if (feature.kind === "resource") {
            if (feature.enabledControl)
              enabled[feature.id] =
                saved.settings[feature.enabledControl.field] !== feature.enabledControl.disabled;
            let ready =
              applied && feature.fieldIds.every((id) => Object.is(saved.settings[id], installed[id]));
            if (feature.resourceTarget) {
              try {
                const status = await featureResourceEngine(adapter, feature).inspect(saved.appPath);
                ready = status.kind === "managed" && !status.upgradeRequired;
              } catch {
                ready = false;
              }
            }
            return [
              feature.id,
              { summary: feature.summarize(saved.settings), installation: ready ? "已安装" : "待安装" },
            ];
          }
          try {
            const preferences = await loadNativePreferences(
              feature,
              path.join(appDataDirectory(adapter.id), feature.dataSubdirectory),
            );
            enabled[feature.id] = preferences.enabled;
            const status = await featureKeybindingInstaller(
              feature,
              path.join(appDataDirectory(adapter.id), feature.dataSubdirectory),
            ).inspect();
            const bridgeStatus = feature.resourceBridge
              ? await new PatchEngine(
                  feature.resourceBridge,
                  path.join(appDataDirectory(adapter.id), feature.dataSubdirectory, "bridge"),
                ).inspect(saved.appPath)
              : undefined;
            const bridgeReady =
              !feature.resourceBridge || (bridgeStatus?.kind === "managed" && !bridgeStatus.upgradeRequired);
            return [
              feature.id,
              {
                summary: preferences.key,
                installation:
                  (!preferences.enabled || bridgeReady) &&
                  preferences.enabled === status.enabled &&
                  (!preferences.enabled ||
                    (preferences.key === status.binding?.key && status.binding?.command === feature.command))
                    ? "已安装"
                    : "待安装",
              },
            ];
          } catch {
            return [feature.id, { summary: feature.description, installation: "需检查" }];
          }
        }),
      );
      if (active) {
        setLabels(Object.fromEntries(entries));
        setEnabledStates(enabled);
        setError("");
      }
    })()
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
  const icons = { plus: Icon.Plus, stop: Icon.Stop, focus: Icon.TextCursor, notification: Icon.Bell };
  return (
    <List
      navigationTitle={adapter.title}
      isLoading={loading || saving}
      searchBarPlaceholder="选择要配置的功能…"
      actions={
        <ActionPanel>
          <Action.Push
            title={`Install / 安装 ${adapter.title}`}
            shortcut={APP_INSTALL_SHORTCUT}
            icon={Icon.Download}
            target={<InstallApp adapter={adapter} onChanged={refresh} />}
          />
          <RemoteInstallAction appId={adapter.id} />
          <Action.Push
            title="应用设置与维护"
            icon={Icon.Gear}
            target={<ConfigureApplication adapter={adapter} onChanged={refresh} />}
          />
          <Action.Push
            title="Add Item / 新增功能"
            shortcut={ADD_ENTRY_SHORTCUT}
            icon={Icon.Plus}
            target={<AddEntry parentId={adapter.id} onChanged={refresh} />}
          />
        </ActionPanel>
      }
    >
      {error && (
        <List.Section title="配置读取失败">
          <List.Item
            title="查看应用设置"
            subtitle={error}
            icon={Icon.ExclamationMark}
            actions={
              <ActionPanel>
                <Action.Push
                  title="打开应用设置"
                  shortcut={ENTER_SHORTCUT}
                  target={<ConfigureApplication adapter={adapter} onChanged={refresh} />}
                />
                <Action.Push
                  title={`Install / 安装 ${adapter.title}`}
                  shortcut={APP_INSTALL_SHORTCUT}
                  icon={Icon.Download}
                  target={<InstallApp adapter={adapter} onChanged={refresh} />}
                />
                <Action.Push
                  title="Add Item / 新增功能"
                  shortcut={ADD_ENTRY_SHORTCUT}
                  icon={Icon.Plus}
                  target={<AddEntry parentId={adapter.id} onChanged={refresh} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      <List.Section title="安装与恢复">
        <List.Item
          title="Install / 安装 App"
          icon={Icon.Download}
          actions={
            <ActionPanel>
              <Action.Push
                title="查看安装计划"
                target={<InstallApp adapter={adapter} onChanged={refresh} />}
              />
              <RestoreAppAction adapter={adapter} onChanged={refresh} />
              <RemoteInstallAction appId={adapter.id} />
            </ActionPanel>
          }
        />
        <List.Item
          title="Restore / 完整恢复 App"
          subtitle="资源与快捷键恢复到安装前"
          icon={Icon.Undo}
          actions={
            <ActionPanel>
              <RestoreAppAction adapter={adapter} onChanged={refresh} />
              <RemoteInstallAction appId={adapter.id} />
            </ActionPanel>
          }
        />
      </List.Section>
      <DraftEntries parentId={adapter.id} revision={revision} onChanged={refresh} />
      <List.Section title="功能" subtitle="单项保存配置，App 统一安装">
        {adapter.features.map((feature) => (
          <List.Item
            key={feature.id}
            title={feature.title}
            subtitle={
              labels[feature.id]?.summary === "已关闭"
                ? feature.description
                : (labels[feature.id]?.summary ?? feature.description)
            }
            icon={icons[feature.symbol]}
            accessories={[
              {
                text: labels[feature.id]?.installation ?? "读取中",
                tooltip:
                  labels[feature.id]?.installation === "已安装"
                    ? "应用资源与已保存配置一致；修改后仍需重新打开应用生效。"
                    : "保存配置后，按 ⌘Enter 统一安装。",
              },
              {
                text:
                  feature.kind === "resource" && !feature.enabledControl
                    ? "随安装"
                    : enabledStates[feature.id] === undefined
                      ? "读取中"
                      : enabledStates[feature.id]
                        ? "已启用"
                        : "已关闭",
                icon: {
                  source: Icon.CircleFilled,
                  tintColor:
                    feature.kind === "resource" && !feature.enabledControl
                      ? Color.SecondaryText
                      : enabledStates[feature.id] === undefined
                        ? Color.SecondaryText
                        : enabledStates[feature.id]
                          ? Color.Green
                          : Color.SecondaryText,
                },
                tooltip:
                  feature.kind === "resource" && !feature.enabledControl
                    ? "此功能随 App 整体安装，使用方式见功能配置。"
                    : "已保存的启用状态。按 ⌘⇧E 切换，再按 ⌘Enter 安装生效。",
              },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="配置功能"
                  shortcut={ENTER_SHORTCUT}
                  icon={Icon.Gear}
                  target={
                    feature.kind === "resource" ? (
                      <ConfigureResourceFeature adapter={adapter} feature={feature} onChanged={refresh} />
                    ) : (
                      <ConfigureNativeFeature adapter={adapter} feature={feature} onChanged={refresh} />
                    )
                  }
                />
                {enabledStates[feature.id] !== undefined && (
                  <Action
                    title={enabledStates[feature.id] ? "关闭此功能" : "启用此功能"}
                    icon={Icon.Power}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                    onAction={() => toggleFeature(feature)}
                  />
                )}
                <Action.Push
                  title={`Install / 安装 ${adapter.title}`}
                  icon={Icon.Download}
                  shortcut={APP_INSTALL_SHORTCUT}
                  target={<InstallApp adapter={adapter} onChanged={refresh} />}
                />
                <RemoteInstallAction appId={adapter.id} />
                <Action.Push
                  title="应用设置与维护"
                  icon={Icon.Gear}
                  target={<ConfigureApplication adapter={adapter} onChanged={refresh} />}
                />
                <Action title="刷新状态" icon={Icon.ArrowClockwise} onAction={refresh} />
                <Action.Push
                  title="Add Item / 新增功能"
                  shortcut={ADD_ENTRY_SHORTCUT}
                  icon={Icon.Plus}
                  target={<AddEntry parentId={adapter.id} onChanged={refresh} />}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
