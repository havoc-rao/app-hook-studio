import { Action, ActionPanel, Form, Icon, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { AppAdapter, AppFeature, AppConfig, SettingValue, defaultConfig } from "../core/contracts";
import { featureResourceEngine } from "../application/app-install";
import { mergeFeatureSettings } from "../core/feature-settings";
import { loadConfig, saveConfig } from "../core/storage";
import { SaveAndInstallAppAction } from "./install-action";
import { ENTER_SHORTCUT } from "./shortcuts";

export function ConfigureResourceFeature({
  adapter,
  feature,
  onChanged,
}: {
  adapter: AppAdapter;
  feature: Extract<AppFeature, { kind: "resource" }>;
  onChanged(): void;
}) {
  const [draft, setDraft] = useState<AppConfig>(() => defaultConfig(adapter));
  const [lastEnabledValue, setLastEnabledValue] = useState<SettingValue | undefined>();
  const [status, setStatus] = useState("读取中…");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      const saved = await loadConfig(adapter);
      if (active) setDraft(saved);
      try {
        const current = await featureResourceEngine(adapter, feature).inspect(saved.appPath);
        if (active)
          setStatus(
            current.upgradeRequired
              ? "需整体安装以升级补丁"
              : current.installedConfig
                ? feature.summarize(current.installedConfig.settings)
                : "尚未安装",
          );
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : String(error));
      }
    })()
      .catch((error: unknown) => void showToast(Toast.Style.Failure, "读取失败", String(error)))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [adapter, feature, revision]);
  const change = (id: string, value: SettingValue) =>
    setDraft((current) => ({ ...current, settings: { ...current.settings, [id]: value } }));
  async function save() {
    const settings = { ...draft.settings };
    for (const field of adapter.fields)
      if (field.type === "number" && typeof settings[field.id] === "string") {
        const text = String(settings[field.id]);
        settings[field.id] = text.trim() ? Number(text) : NaN;
      }
    const config = mergeFeatureSettings(adapter, feature, await loadConfig(adapter), settings);
    await saveConfig(adapter, config);
    onChanged();
  }
  return (
    <Form
      navigationTitle={`${adapter.title} · ${feature.title}`}
      isLoading={loading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存配置"
            icon={Icon.SaveDocument}
            shortcut={ENTER_SHORTCUT}
            onSubmit={async () => {
              try {
                await save();
                await showToast(Toast.Style.Success, "配置已保存", "尚未写入 App；请在 App 层统一 Install。");
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
      <Form.Description title={feature.title} text={feature.description} />
      <Form.Description title="当前生效" text={status} />
      {feature.configurationNote && <Form.Description title="使用方式" text={feature.configurationNote} />}
      {feature.enabledControl && typeof feature.enabledControl.disabled !== "boolean" && (
        <Form.Checkbox
          id="featureEnabled"
          title="启用"
          label={`安装时启用${feature.title}快捷键`}
          value={draft.settings[feature.enabledControl.field] !== feature.enabledControl.disabled}
          onChange={(enabled) => {
            const control = feature.enabledControl!;
            if (!enabled) setLastEnabledValue(draft.settings[control.field]);
            change(control.field, enabled ? (lastEnabledValue ?? control.enabled) : control.disabled);
          }}
        />
      )}
      {adapter.fields
        .filter(
          (field) =>
            feature.fieldIds.includes(field.id) &&
            (!field.when || draft.settings[field.when.field] === field.when.equals) &&
            (!feature.enabledControl ||
              typeof feature.enabledControl.disabled === "boolean" ||
              draft.settings[feature.enabledControl.field] !== feature.enabledControl.disabled),
        )
        .map((field) => {
          const value = draft.settings[field.id];
          if (field.type === "checkbox")
            return (
              <Form.Checkbox
                key={field.id}
                id={field.id}
                title={field.title}
                info={field.info}
                label={field.label}
                value={value === true}
                onChange={(v) => change(field.id, v)}
              />
            );
          if (field.type === "select")
            return (
              <Form.Dropdown
                key={field.id}
                id={field.id}
                title={field.title}
                info={field.info}
                value={String(value)}
                onChange={(v) => change(field.id, v)}
              >
                {field.options
                  .filter(
                    (option) => !feature.enabledControl || option.value !== feature.enabledControl.disabled,
                  )
                  .map((option) => (
                    <Form.Dropdown.Item key={option.value} value={option.value} title={option.title} />
                  ))}
              </Form.Dropdown>
            );
          return (
            <Form.TextField
              key={field.id}
              id={field.id}
              title={field.title}
              info={field.info}
              placeholder={field.placeholder}
              value={String(value)}
              onChange={(v) => change(field.id, v)}
            />
          );
        })}
      <Form.Description
        title="应用方式"
        text="Enter 保存本项配置。⌘Enter 保存后进入整个 App 的安装确认页；确认后再次 ⌘Enter 执行整体安装。"
      />
      <Form.Description title="作用范围" text="作用域由适配器或 Recipe 声明。保存设置不会立即修改应用。" />
    </Form>
  );
}
