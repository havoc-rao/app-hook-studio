import { ADD_ENTRY_SHORTCUT, REFRESH_SHORTCUT } from "./shortcuts";
import { Action, ActionPanel, Detail, Form, Icon, List, Toast, showToast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { addDraft, catalogEvents, CatalogDraft, readDrafts } from "../core/catalog";

export function AddEntry({ parentId = "", onChanged = () => {} }: { parentId?: string; onChanged?(): void }) {
  const app = !parentId;
  const [files, setFiles] = useState<string[]>([]);
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={app ? "Add App" : "Add Item"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存草稿"
            icon={Icon.Plus}
            onSubmit={async (values: {
              title: string;
              version: string;
              target: string;
              description: string;
              enabled: boolean;
            }) => {
              try {
                await addDraft({ ...values, appPath: files[0] ?? "", parentId, kind: app ? "app" : "item" });
                onChanged();
                await showToast(Toast.Style.Success, "已添加", "已保存为待分析草稿；接入适配器后才能安装。");
                pop();
              } catch (error) {
                await showToast(Toast.Style.Failure, "添加失败", String(error));
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title={app ? "App 名称" : "功能名称"} />
      {app && (
        <Form.FilePicker
          id="appPath"
          title="选择 App"
          allowMultipleSelection={false}
          canChooseDirectories
          canChooseFiles={false}
          value={files}
          onChange={setFiles}
        />
      )}
      <Form.TextField id="version" title="目标 App 版本" placeholder="例如 1.106.1 / genie 3.10.0" />
      {!app && (
        <Form.TextField id="target" title="目标资源 / 事件" placeholder="包内相对路径、按钮事件或命令 ID" />
      )}
      {app && (
        <Form.TextField
          id="target"
          title="分析配置路径"
          placeholder="可选：code-agent 分析结果或 Recipe 文件路径"
        />
      )}
      <Form.TextArea id="description" title="说明" placeholder="期望行为、快捷键，以及已有分析证据" />
      <Form.Checkbox id="enabled" title="启用意向" label="接入后启用此条目" defaultValue />
      <Form.Description
        title="待分析接入"
        text="这里保存本地草稿，不会执行代码或修改目标 App。版本、摘要和动作映射经适配器验证接入后，仍以 App 为单位统一安装。"
      />
    </Form>
  );
}

function DraftDetails({ entry }: { entry: CatalogDraft }) {
  return (
    <Detail
      markdown={`# ${entry.title}\n\n状态：待分析接入\n\n版本：${entry.version || "未指定"}\n\n启用意向：${entry.enabled ? "启用" : "关闭"}\n\n目标：${entry.target || "未指定"}\n\n${entry.description}`}
    />
  );
}
function DraftApp({ entry }: { entry: CatalogDraft }) {
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((v) => v + 1);
  return (
    <List
      navigationTitle={entry.title}
      actions={
        <ActionPanel>
          <Action.Push
            title="Add Item / 新增功能"
            shortcut={ADD_ENTRY_SHORTCUT}
            icon={Icon.Plus}
            target={<AddEntry parentId={entry.id} onChanged={refresh} />}
          />
        </ActionPanel>
      }
    >
      <List.Section title="App 信息">
        <List.Item
          title={entry.title}
          subtitle={`${entry.version || "版本待指定"} · 待分析接入`}
          icon={{ fileIcon: entry.appPath }}
          actions={
            <ActionPanel>
              <Action.Push title="查看详情" target={<DraftDetails entry={entry} />} />
              <Action
                title="刷新功能"
                shortcut={REFRESH_SHORTCUT}
                icon={Icon.ArrowClockwise}
                onAction={refresh}
              />
              <Action.Push
                title="Add Item / 新增功能"
                shortcut={ADD_ENTRY_SHORTCUT}
                icon={Icon.Plus}
                target={<AddEntry parentId={entry.id} onChanged={refresh} />}
              />
            </ActionPanel>
          }
        />
      </List.Section>
      <DraftEntries parentId={entry.id} revision={revision} onChanged={refresh} />
    </List>
  );
}
export function DraftEntries({
  parentId = "",
  revision = 0,
  onChanged = () => {},
}: {
  parentId?: string;
  revision?: number;
  onChanged?(): void;
}) {
  const [entries, setEntries] = useState<CatalogDraft[]>([]);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const refresh = () => setChanges((v) => v + 1);
    catalogEvents.on("changed", refresh);
    return () => {
      catalogEvents.off("changed", refresh);
    };
  }, []);
  useEffect(() => {
    let active = true;
    readDrafts()
      .then((all) => {
        if (active) setEntries(all.filter((entry) => entry.parentId === parentId));
      })
      .catch((error: unknown) => void showToast(Toast.Style.Failure, "目录读取失败", String(error)));
    return () => {
      active = false;
    };
  }, [parentId, revision, changes]);
  return (
    <List.Section title="待分析接入">
      {entries.map((entry) => (
        <List.Item
          key={entry.id}
          title={entry.title}
          subtitle={entry.version || "版本待指定"}
          icon={entry.kind === "app" ? { fileIcon: entry.appPath } : Icon.Code}
          accessories={[{ tag: "草稿" }]}
          actions={
            <ActionPanel>
              <Action.Push
                title={entry.kind === "app" ? "查看功能" : "查看详情"}
                target={entry.kind === "app" ? <DraftApp entry={entry} /> : <DraftDetails entry={entry} />}
              />
              <Action
                title="刷新条目"
                shortcut={REFRESH_SHORTCUT}
                icon={Icon.ArrowClockwise}
                onAction={() => {
                  setChanges((v) => v + 1);
                  onChanged();
                }}
              />
              <Action.Push
                title={parentId ? "Add Item / 新增功能" : "Add App / 新增应用"}
                shortcut={ADD_ENTRY_SHORTCUT}
                icon={Icon.Plus}
                target={<AddEntry parentId={parentId} onChanged={onChanged} />}
              />
            </ActionPanel>
          }
        />
      ))}
    </List.Section>
  );
}
