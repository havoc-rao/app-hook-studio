import { Action, ActionPanel, Form, Icon, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import path from "node:path";
import { AppAdapter, AppFeature } from "../core/contracts";
import { appDataDirectory } from "../core/storage";
import { loadNativePreferences, saveNativePreferences } from "../application/app-install";
import { featureKeybindingInstaller } from "../installers/ide-keybinding";
import { SaveAndInstallAppAction } from "./install-action";
import { ENTER_SHORTCUT } from "./shortcuts";

type NativeFeature = Extract<AppFeature, { kind: "ide-keybinding" }>;
export function ConfigureNativeFeature({
  adapter,
  feature,
  onChanged,
}: {
  adapter: AppAdapter;
  feature: NativeFeature;
  onChanged(): void;
}) {
  const [key, setKey] = useState(feature.defaultShortcut);
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState("读取中…");
  const [revision, setRevision] = useState(0);
  const directory = path.join(appDataDirectory(adapter.id), feature.dataSubdirectory);
  useEffect(() => {
    let active = true;
    (async () => {
      const preferences = await loadNativePreferences(feature, directory);
      const current = await featureKeybindingInstaller(feature, directory, preferences.key).inspect();
      if (active) {
        setKey(preferences.key);
        setEnabled(preferences.enabled);
        setStatus(
          current.enabled
            ? `${current.binding?.key} · ${current.binding?.command === feature.command ? "规则已安装（桥接须整体安装）" : "旧聚焦视图规则，待整体安装升级"}`
            : "尚未启用",
        );
      }
    })().catch((error: unknown) => {
      if (active) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, [adapter, feature, revision]);
  async function save() {
    await saveNativePreferences(directory, { key, enabled });
    onChanged();
  }
  return (
    <Form
      navigationTitle={`${adapter.title} · ${feature.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存配置"
            icon={Icon.SaveDocument}
            shortcut={ENTER_SHORTCUT}
            onSubmit={async () => {
              try {
                await save();
                await showToast(
                  Toast.Style.Success,
                  "配置已保存",
                  "快捷键文件尚未修改；请在 App 层统一 Install。",
                );
              } catch (error) {
                await showToast(
                  Toast.Style.Failure,
                  "保存失败",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
          <SaveAndInstallAppAction
            adapter={adapter}
            save={save}
            onChanged={() => {
              onChanged();
              setRevision((value) => value + 1);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title={feature.title} text={status} />
      <Form.Checkbox
        id="enabled"
        title="启用"
        label="安装时启用聚焦快捷键"
        value={enabled}
        onChange={setEnabled}
      />
      <Form.TextField
        id="shortcut"
        title="快捷键"
        value={key}
        onChange={setKey}
        placeholder={feature.defaultShortcut}
      />
      <Form.Description title="作用范围" text={`${adapter.title} 窗口内全局，包括编辑器、终端和面板。`} />
      <Form.Description
        title="应用方式"
        text="本页只保存配置。⌘Enter 保存后进入整个 App 的安装确认页，所有功能一起应用。"
      />
      <Form.Description title="验证说明" text={feature.verificationNote} />
    </Form>
  );
}
