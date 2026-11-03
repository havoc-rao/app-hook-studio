import { Form } from "@raycast/api";
import { useEffect, useState } from "react";
import { AppAdapter, AppVersion } from "../core/contracts";

export function formatAppVersion(version: AppVersion): string {
  return [version.app, ...Object.entries(version.components).map(([name, value]) => `${name} ${value}`)].join(
    " / ",
  );
}

/** Version is read from the selected package, never entered as a compatibility override. */
export function AppVersionFields({ adapter, appPath }: { adapter: AppAdapter; appPath: string }) {
  const [current, setCurrent] = useState("读取中…");
  useEffect(() => {
    let active = true;
    setCurrent("读取中…");
    if (!adapter.versions) {
      setCurrent("此适配器未提供版本读取能力");
      return;
    }
    adapter.versions
      .read(appPath)
      .then((version) => {
        if (active) setCurrent(formatAppVersion(version));
      })
      .catch((error: unknown) => {
        if (active) setCurrent(`无法确认：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      active = false;
    };
  }, [adapter, appPath]);
  return (
    <>
      <Form.Description title="当前 App 版本" text={current} />
      <Form.Description
        title="补丁支持版本"
        text={adapter.versions ? formatAppVersion(adapter.versions.supported) : adapter.supportDescription}
      />
      <Form.Description
        title="版本约束"
        text="版本从应用包自动读取，不可手动覆盖兼容性检查。安装还会校验资源摘要与注入位置；相同版本号也不保证兼容。"
      />
    </>
  );
}
