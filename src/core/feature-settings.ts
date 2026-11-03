import { AppAdapter, AppConfig, AppFeature, Settings, validateAppConfig } from "./contracts";

/** Merge only the selected feature's fields into the latest saved config. */
export function mergeFeatureSettings(
  adapter: AppAdapter,
  feature: Extract<AppFeature, { kind: "resource" }>,
  latest: AppConfig,
  draft: Settings,
): AppConfig {
  if (latest.appId !== adapter.id) throw new Error("应用配置不匹配。");
  const known = new Set(adapter.fields.map((field) => field.id));
  const settings = { ...latest.settings };
  for (const id of feature.fieldIds) {
    if (!known.has(id)) throw new Error(`功能引用了未知字段：${id}`);
    settings[id] = draft[id];
  }
  return validateAppConfig(adapter, { ...latest, settings });
}
