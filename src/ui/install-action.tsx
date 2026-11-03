import { Action, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { AppAdapter } from "../core/contracts";
import { InstallApp } from "./install-app";
import { APP_INSTALL_SHORTCUT } from "./shortcuts";

export function SaveAndInstallAppAction({
  adapter,
  save,
  onChanged,
}: {
  adapter: AppAdapter;
  save(): Promise<void>;
  onChanged(): void;
}) {
  const { push } = useNavigation();
  return (
    <Action
      title={`Install / 安装 ${adapter.title}`}
      icon={Icon.Download}
      shortcut={APP_INSTALL_SHORTCUT}
      onAction={async () => {
        try {
          await save();
          onChanged();
          push(<InstallApp adapter={adapter} onChanged={onChanged} />);
        } catch (error) {
          await showToast(
            Toast.Style.Failure,
            "配置未保存，未开始安装",
            error instanceof Error ? error.message : String(error),
          );
        }
      }}
    />
  );
}
