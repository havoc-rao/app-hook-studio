import { readFile } from "node:fs/promises";
import path from "node:path";
export async function readCodebuddyVersion(appPath: string) {
  const root = path.join(appPath, "Contents/Resources/app");
  const app: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const extension: unknown = JSON.parse(
    await readFile(path.join(root, "extensions/genie/package.json"), "utf8"),
  );
  const appVersion = (app as Record<string, unknown>)?.version;
  const extensionVersion = (extension as Record<string, unknown>)?.version;
  if (
    typeof appVersion !== "string" ||
    !appVersion.trim() ||
    typeof extensionVersion !== "string" ||
    !extensionVersion.trim()
  )
    throw new Error("应用包缺少有效版本字段，无法确认兼容性。");
  return { app: appVersion, components: { genie: extensionVersion } };
}
