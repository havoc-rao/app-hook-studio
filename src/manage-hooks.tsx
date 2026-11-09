import { RestoreAppAction } from "./ui/restore-app";
import path from "node:path";
import { configureResourceWorker } from "./core/resource-worker";
import { Action, ActionPanel, Icon, List, environment } from "@raycast/api";
import { RegisteredApps, recipeUiEvents } from "./ui/registered-apps";
import CodexCli from "./apps/codex-cli/manage";
import { CLI_ADAPTERS } from "./apps/codex-cli/registry";
import { APP_ADAPTERS } from "./apps/registry";
import { InstallApp } from "./ui/install-app";
import { ENTER_SHORTCUT, APP_INSTALL_SHORTCUT, ADD_ENTRY_SHORTCUT, REFRESH_SHORTCUT } from "./ui/shortcuts";
import { AppFeatures } from "./ui/app-features";
import { RemoteInstallAction } from "./ui/remote-install";

import { AddEntry, DraftEntries } from "./ui/add-entry";
import { formatAppVersion } from "./ui/app-version";

configureResourceWorker(path.join(environment.assetsPath, "resource-worker.cjs"));

export default function ManageHooks() {
  return (
    <List
      navigationTitle="App Hook Studio"
      searchBarPlaceholder="选择应用…"
      actions={
        <ActionPanel>
          <RemoteInstallAction />
          <Action.Push
            title="Add App / 新增应用"
            shortcut={ADD_ENTRY_SHORTCUT}
            icon={Icon.Plus}
            target={<AddEntry />}
          />
          <Action
            title="刷新注册应用"
            shortcut={REFRESH_SHORTCUT}
            icon={Icon.ArrowClockwise}
            onAction={() => recipeUiEvents.emit("refresh")}
          />
        </ActionPanel>
      }
    >
      <RegisteredApps />
      <DraftEntries />
      <List.Section title="CLI 接入">
        {CLI_ADAPTERS.map((adapter) => (
          <List.Item
            key={adapter.id}
            title={adapter.title}
            subtitle={adapter.description}
            icon="chatgpt.png"
            accessories={[{ tag: "CLI" }]}
            actions={
              <ActionPanel>
                <Action.Push title="配置与安装 CLI" shortcut={ENTER_SHORTCUT} target={<CodexCli />} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {APP_ADAPTERS.map((adapter) => (
        <List.Item
          key={adapter.id}
          title={adapter.title}
          subtitle={
            adapter.versions
              ? `支持 ${formatAppVersion(adapter.versions.supported)}`
              : adapter.supportDescription
          }
          icon={{ fileIcon: adapter.defaultAppPath }}
          accessories={[{ text: `${adapter.features.length} 项功能` }]}
          actions={
            <ActionPanel>
              <Action.Push
                title="查看功能"
                shortcut={ENTER_SHORTCUT}
                target={<AppFeatures adapter={adapter} />}
              />
              <Action.Push
                title="Install / 安装 App"
                icon={Icon.Download}
                shortcut={APP_INSTALL_SHORTCUT}
                target={<InstallApp adapter={adapter} />}
              />
              <RemoteInstallAction appId={adapter.id} />
              <RestoreAppAction adapter={adapter} />
              <Action.Push
                title="Add App / 新增应用"
                shortcut={ADD_ENTRY_SHORTCUT}
                icon={Icon.Plus}
                target={<AddEntry />}
              />
              <Action
                title="刷新注册应用"
                shortcut={REFRESH_SHORTCUT}
                icon={Icon.ArrowClockwise}
                onAction={() => recipeUiEvents.emit("refresh")}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
