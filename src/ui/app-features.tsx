import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import path from "node:path";
import { AppAdapter } from "../core/contracts";
import { loadConfig, appDataDirectory } from "../core/storage";
import { PatchEngine } from "../core/engine";
import { featureKeybindingInstaller } from "../installers/ide-keybinding";
import { ConfigureResourceFeature } from "./configure-resource-feature";
import { ConfigureNativeFeature } from "./configure-native-feature";
import { InstallApp } from "./install-app";
import { ENTER_SHORTCUT, APP_INSTALL_SHORTCUT, ADD_ENTRY_SHORTCUT } from "./shortcuts";
import { loadNativePreferences } from "../application/app-install";
import { AddEntry, DraftEntries } from "./add-entry";
import { ConfigureApplication } from "./configure-application";

export function AppFeatures({ adapter }: { adapter: AppAdapter }) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [enabledStates, setEnabledStates] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
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
        adapter.features.map(async (feature): Promise<[string, string]> => {
          if (feature.kind === "resource") {
            if (feature.enabledControl)
              enabled[feature.id] =
                saved.settings[feature.enabledControl.field] !== feature.enabledControl.disabled;
            return [
              feature.id,
              `${feature.summarize(saved.settings)} · ${applied && feature.fieldIds.every((id) => Object.is(saved.settings[id], installed[id])) ? "已安装" : "待安装"}`,
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
              `${preferences.enabled ? preferences.key : "已关闭"} · ${(!preferences.enabled || bridgeReady) && preferences.enabled === status.enabled && (!preferences.enabled || (preferences.key === status.binding?.key && status.binding?.command === feature.command)) ? "已安装" : "待安装"}`,
            ];
          } catch {
            return [feature.id, "需检查配置"];
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
  const icons = { plus: Icon.Plus, stop: Icon.Stop, focus: Icon.TextCursor };
  return (
    <List
      navigationTitle={adapter.title}
      isLoading={loading}
      searchBarPlaceholder="选择要配置的功能…"
      actions={
        <ActionPanel>
          <Action.Push
            title={`Install / 安装 ${adapter.title}`}
            shortcut={APP_INSTALL_SHORTCUT}
            icon={Icon.Download}
            target={<InstallApp adapter={adapter} onChanged={refresh} />}
          />
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
      <DraftEntries parentId={adapter.id} revision={revision} onChanged={refresh} />
      <List.Section title="功能" subtitle="单项保存配置，App 统一安装">
        {adapter.features.map((feature) => (
          <List.Item
            key={feature.id}
            title={feature.title}
            subtitle={feature.description}
            icon={icons[feature.symbol]}
            accessories={[
              ...(enabledStates[feature.id] === undefined
                ? []
                : [{ tag: enabledStates[feature.id] ? "已启用" : "已关闭" }]),
              { text: labels[feature.id] ?? "读取中…" },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title={`配置${feature.title}`}
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
                <Action.Push
                  title={`Install / 安装 ${adapter.title}`}
                  icon={Icon.Download}
                  shortcut={APP_INSTALL_SHORTCUT}
                  target={<InstallApp adapter={adapter} onChanged={refresh} />}
                />
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
