import { Action, ActionPanel, Form, Icon, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { AppAdapter } from "../core/contracts";
import { prepareAppRestore } from "../application/app-install";
import { snapshotDirectory } from "../application/app-snapshot";

export function RestoreApp({ adapter, onChanged = () => {} }: { adapter: AppAdapter; onChanged?(): void }) {
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof prepareAppRestore>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setPlan(undefined);
    setError("");
    setDone(false);
    setSteps([]);
    prepareAppRestore(adapter)
      .then((value) => {
        if (active) setPlan(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [adapter, revision]);
  async function restore() {
    if (!plan || busy || done) return;
    setBusy(true);
    setError("");
    setSteps([]);
    const toast = await showToast(Toast.Style.Animated, "完整恢复中");
    try {
      await plan.execute((title) => setSteps((current) => [...current, title]));
      setDone(true);
      toast.style = Toast.Style.Success;
      toast.title = "已完整恢复";
      toast.message = "目标文件已恢复安装前状态；备份保留，请重新打开应用。";
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.style = Toast.Style.Failure;
      toast.title = "恢复未完成";
      toast.message = message;
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  return (
    <Form
      navigationTitle={`Restore · ${adapter.title}`}
      isLoading={busy}
      actions={
        <ActionPanel>
          {plan && !done && (
            <Action.SubmitForm
              title="Restore / 完整恢复"
              icon={Icon.Undo}
              shortcut={{ modifiers: ["cmd"], key: "return" }}
              onSubmit={restore}
            />
          )}
          <Action
            title="重新检查"
            icon={Icon.ArrowClockwise}
            onAction={() => {
              if (!busy) setRevision((value) => value + 1);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="恢复范围"
        text="精确恢复首次完整快照中的应用资源与快捷键文件；原先不存在的文件会删除。备份、恢复记录及已保存的功能偏好保留。"
      />
      <Form.Description
        title="恢复前"
        text={`保存工作并用 ⌘Q 完全退出 ${adapter.title}。校验所有目标和备份后才写入；不会自动强退。`}
      />
      {plan && <Form.Description title="应用路径" text={plan.appPath} />}
      {plan?.legacy && (
        <Form.Description
          title="旧版迁移"
          text="旧资源备份已校验；旧快捷键备份能够精确重建当前文件。执行时先建立完整恢复记录，再恢复文件。"
        />
      )}
      {plan?.entries.map((entry) => (
        <Form.Description
          key={entry.target}
          title={entry.title}
          text={`${entry.target}\n${entry.before === null ? "恢复为不存在" : "恢复首次备份的完整内容"}`}
        />
      ))}
      {plan && <Form.Description title="备份目录" text={snapshotDirectory(plan.appPath)} />}
      <Form.Description
        title="修改冲突"
        text="安装后有其他修改时拒绝覆盖。多文件恢复不是跨文件事务；中途失败保留已完成项与备份，处理原因后可再次 Restore。"
      />
      {error && <Form.Description title="需要处理" text={error} />}
      {steps.map((title, index) => (
        <Form.Description key={index} title={title} text="已恢复并校验" />
      ))}
      {done && <Form.Description title="恢复完成" text="重新打开应用生效；也可以先 Install 安装新配置。" />}
    </Form>
  );
}

export function RestoreAppAction({ adapter, onChanged }: { adapter: AppAdapter; onChanged?(): void }) {
  return (
    <Action.Push
      title="Restore / 完整恢复 App"
      icon={Icon.Undo}
      target={<RestoreApp adapter={adapter} onChanged={onChanged} />}
    />
  );
}
