import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppAdapter, AppConfig, defaultConfig, validateAppConfig } from "./contracts";

export const DATA_ROOT = path.join(homedir(), "Library/Application Support/App Hook Studio");
export const appDataDirectory = (appId: string): string => path.join(DATA_ROOT, "apps", appId);
export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function writeAtomic(file: string, bytes: string | Buffer, mode = 0o600): Promise<void> {
  const temp = path.join(path.dirname(file), `.app-hook-studio-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
  } finally {
    await handle?.close();
    await fs.unlink(temp).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export async function loadConfig(
  adapter: AppAdapter,
  directory = appDataDirectory(adapter.id),
): Promise<AppConfig> {
  try {
    return validateAppConfig(
      adapter,
      JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8")),
    );
  } catch (error) {
    if (!isMissing(error))
      throw new Error(`无法读取已保存配置：${error instanceof Error ? error.message : String(error)}`);
  }
  if (adapter.legacyConfig) {
    try {
      const legacy = adapter.legacyConfig.decode(
        JSON.parse(await fs.readFile(adapter.legacyConfig.path, "utf8")),
      );
      return validateAppConfig(adapter, { schema: 1, appId: adapter.id, ...legacy });
    } catch (error) {
      if (!isMissing(error))
        throw new Error(`无法读取旧项目配置：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return defaultConfig(adapter);
}

export async function saveConfig(
  adapter: AppAdapter,
  config: AppConfig,
  directory = appDataDirectory(adapter.id),
): Promise<void> {
  const validated = validateAppConfig(adapter, config);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(directory, "settings.json"), JSON.stringify(validated, null, 2) + "\n");
}
