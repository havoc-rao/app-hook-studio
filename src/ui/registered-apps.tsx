import { RestoreAppAction } from "./restore-app";
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { AppAdapter } from "../core/contracts";
import { registeredRecipes } from "../recipes/store";
import { recipeAdapter } from "../recipes/adapter";
import { AppFeatures } from "./app-features";
import { InstallApp } from "./install-app";
import { APP_INSTALL_SHORTCUT, ENTER_SHORTCUT } from "./shortcuts";
export const recipeUiEvents = new EventEmitter();
export function RegisteredApps() {
  const [apps, setApps] = useState<AppAdapter[]>([]),
    [errors, setErrors] = useState<string[]>([]),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    recipeUiEvents.on("refresh", refresh);
    return () => {
      recipeUiEvents.off("refresh", refresh);
    };
  }, []);
  useEffect(() => {
    let active = true;
    registeredRecipes()
      .then((loaded) => {
        if (active) {
          setApps(loaded.recipes.map(recipeAdapter));
          setErrors(loaded.errors);
        }
      })
      .catch((error: unknown) => {
        if (active) setErrors([String(error)]);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <List.Section title="MCP 注册应用">
      {errors.map((error) => (
        <List.Item
          key={error}
          title="注册配置读取失败"
          subtitle={error}
          icon={Icon.ExclamationMark}
          actions={
            <ActionPanel>
              <Action title="刷新注册应用" onAction={refresh} />
            </ActionPanel>
          }
        />
      ))}
      {apps.map((adapter) => (
        <List.Item
          key={adapter.id}
          title={adapter.title}
          subtitle={adapter.supportDescription}
          icon={{ fileIcon: adapter.defaultAppPath }}
          accessories={[{ tag: "Recipe" }, { text: `${adapter.features.length} 项功能` }]}
          actions={
            <ActionPanel>
              <Action.Push
                title="查看功能"
                shortcut={ENTER_SHORTCUT}
                target={<AppFeatures adapter={adapter} />}
              />
              <Action.Push
                title="Install / 安装 App"
                shortcut={APP_INSTALL_SHORTCUT}
                icon={Icon.Download}
                target={<InstallApp adapter={adapter} />}
              />
              <RestoreAppAction adapter={adapter} />
              <Action title="刷新注册应用" icon={Icon.ArrowClockwise} onAction={refresh} />
            </ActionPanel>
          }
        />
      ))}
    </List.Section>
  );
}
