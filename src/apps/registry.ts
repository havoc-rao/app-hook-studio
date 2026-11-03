import { AppAdapter } from "../core/contracts";
import { codebuddyAdapter } from "./codebuddy-cn/adapter";

export const DEFAULT_APP_ID = "codebuddy-cn";
export const APP_ADAPTERS: readonly AppAdapter[] = [codebuddyAdapter];
const byId = new Map(APP_ADAPTERS.map((adapter) => [adapter.id, adapter]));
if (byId.size !== APP_ADAPTERS.length) throw new Error("应用 adapter ID 重复。");
export function getAdapter(id: string): AppAdapter {
  const adapter = byId.get(id);
  if (!adapter) throw new Error(`未知应用：${id}。使用 npm run cli -- list 查看已支持应用。`);
  return adapter;
}
