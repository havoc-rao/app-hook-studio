import {
  Action,
  ActionPanel,
  Alert,
  Detail,
  Form,
  Icon,
  LocalStorage,
  Toast,
  confirmAlert,
  environment,
  showToast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import {
  RemoteCommand,
  RemoteConnection,
  runRemoteInstall,
  discoverRemotePython,
  validateRemoteConnection,
  parseRemotePreflight,
  RemoteVerifiedTarget,
} from "../application/remote-install";

const STORAGE_KEY = "codebuddy-remote-install-v1";
const DEFAULTS = {
  host: "",
  port: "22",
  python: "",
  new_chat_enabled: true,
  new_chat: "ctrl+cmd+n",
  stop_enabled: true,
  stop: "esc,esc",
  focus_enabled: true,
  focus: "cmd+i",
  double_escape_ms: "500",
  scope: "panel",
};
type Preferences = typeof DEFAULTS;
const TITLES: Record<RemoteCommand, string> = {
  preflight: "检测目标版本与兼容性",
  status: "查看远程状态",
  apply: "安装远程补丁",
  restore: "恢复远程原文件",
};

export function RemoteInstallAction({ appId }: { appId?: string }) {
  if (appId && appId !== "codebuddy-cn") return null;
  return <Action.Push title="Remote / 远程安装" icon={Icon.Network} target={<RemoteInstall />} />;
}

export function RemoteInstall() {
  const [values, setValues] = useState<Preferences>(DEFAULTS);
  const [automaticPython, setAutomaticPython] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const [summary, setSummary] = useState("");
  const [verified, setVerified] = useState<{
    target: RemoteVerifiedTarget;
    connection: RemoteConnection;
    fingerprint: string;
  }>();
  const fingerprint = JSON.stringify({ values, automaticPython });
  const currentFingerprint = useRef(fingerprint);
  currentFingerprint.current = fingerprint;
  const ready = verified?.fingerprint === fingerprint ? verified : undefined;
  useEffect(() => {
    let active = true;
    LocalStorage.getItem<string>(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw) as Record<string, unknown>;
        const restored = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS) as (keyof Preferences)[]) {
          if (typeof saved[key] !== typeof DEFAULTS[key])
            throw new Error("远程配置格式无效，请重新保存配置。");
          Object.assign(restored, { [key]: saved[key] });
        }
        if (active) {
          setValues({ ...restored, python: restored.python === "auto" ? "" : restored.python });
          // Older settings have no explicit mode: default to automatic discovery.
          setAutomaticPython(typeof saved.automaticPython === "boolean" ? saved.automaticPython : true);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setVerified(undefined);
    setValues((previous) => ({ ...previous, [key]: value }));
  }
  function connection(): RemoteConnection {
    const value = {
      host: values.host.trim(),
      port: values.port.trim(),
      python: automaticPython ? "auto" : values.python.trim(),
    };
    if (!automaticPython && value.python === "auto")
      throw new Error("手动模式请填写 Python 可执行文件名或绝对路径，或开启自动查找。");
    return validateRemoteConnection(value);
  }
  function config() {
    const interval = Number(values.double_escape_ms);
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error("双 Esc 间隔必须是正整数（毫秒）。");
    for (const key of ["new_chat", "stop", "focus"] as const) {
      if (!values[key].trim()) throw new Error("快捷键不能为空；关闭功能请取消勾选对应开关。");
    }
    return {
      new_chat_enabled: values.new_chat_enabled,
      new_chat: values.new_chat.trim(),
      stop_enabled: values.stop_enabled,
      stop: values.stop.trim(),
      focus_enabled: values.focus_enabled,
      focus: values.focus.trim(),
      double_escape_ms: interval,
      scope: values.scope,
    };
  }
  async function execute(command: RemoteCommand | "save") {
    if (loading || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const operationFingerprint = fingerprint;
      if (command === "apply" && !ready)
        throw new Error("请先检测目标版本与兼容性；修改连接或配置后必须重新检测。");
      if (command === "preflight") setVerified(undefined);
      const target = command === "apply" ? { ...ready!.connection } : connection();
      // Status/restore must remain available even when an edited shortcut is invalid.
      const settings =
        command === "apply" || command === "preflight" || command === "save" ? config() : undefined;
      if (command === "apply" || command === "restore") {
        const confirmed = await confirmAlert({
          title: `${TITLES[command]}？`,
          message: `${target.host}:${target.port}\n${command === "apply" ? `CodeBuddy ${ready!.target.appVersion} / genie ${ready!.target.extensionVersion}\ncommit: ${ready!.target.commit}\n目标: ${ready!.target.base}\n修改远端已验证构建的宿主和 Webview 资源。已有安装必须先恢复；不会自动覆盖或恢复。` : "使用远端首次备份恢复两份资源，不修改本机文件。"}\n请先保存远程工作；完成后重新连接远程窗口，必要时重启扩展宿主。`,
          primaryAction: { title: TITLES[command], style: Alert.ActionStyle.Destructive },
        });
        if (!confirmed) return;
      }
      await LocalStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...values,
          host: target.host,
          port: target.port,
          automaticPython,
        }),
      );
      setError("");
      if (command === "save") {
        await showToast(Toast.Style.Success, "远程配置已保存", "尚未连接或修改远端。");
        return;
      }
      setOutput("");
      setSummary("");
      const toast = await showToast(Toast.Style.Animated, TITLES[command]);
      try {
        // Resolve once per operation so preflight and apply use the same interpreter.
        if (target.python === "auto") {
          toast.message = "正在只读检测远端 Python 3.9+…";
          target.python = await discoverRemotePython(target);
          toast.message = `使用 ${target.python}`;
        }
        const options = {
          assetsPath: environment.assetsPath,
          connection: target,
          config: settings,
          expectedCommit: command === "apply" ? ready!.target.commit : undefined,
        };
        if (command === "apply") {
          const checked = parseRemotePreflight(await runRemoteInstall({ ...options, command: "preflight" }));
          if (JSON.stringify(checked) !== JSON.stringify(ready!.target))
            throw new Error("目标版本或目录已变更，请重新检测后再安装。");
          if (currentFingerprint.current !== operationFingerprint)
            throw new Error("配置已变更，已停止安装，请重新检测。");
          setVerified(undefined);
        }
        const result = await runRemoteInstall({ ...options, command });
        setOutput(result);
        if (command === "preflight") {
          const checked = parseRemotePreflight(result);
          if (currentFingerprint.current !== operationFingerprint)
            throw new Error("检测期间配置已变更，请重新检测；本次未写入远端。");
          setVerified({ target: checked, connection: target, fingerprint: operationFingerprint });
        }
        if (command === "restore") setVerified(undefined);
        const message =
          command === "apply" || command === "restore"
            ? "远端磁盘操作完成。请重新连接远程窗口，必要时重新加载窗口或重启扩展宿主；尚未验证实际会话。"
            : "只读检查完成，未修改远端资源。可在 ⌘K 中查看完整输出。";
        setSummary(`${TITLES[command]}成功 · ${target.host}:${target.port}\n${message}`);
        toast.style = Toast.Style.Success;
        toast.title = `${TITLES[command]}完成`;
        toast.message = message;
      } catch (reason) {
        toast.style = Toast.Style.Failure;
        toast.title = `${TITLES[command]}失败`;
        toast.message = reason instanceof Error ? reason.message : String(reason);
        throw reason;
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (command !== "save") setVerified(undefined);
      setError(message);
      await showToast(Toast.Style.Failure, "远程操作未完成", "按 ⌘K → 查看完整错误，或复制错误信息。");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle="Remote · CodeBuddy CN"
      isLoading={loading || busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="检测目标版本与兼容性"
            icon={Icon.MagnifyingGlass}
            onSubmit={() => execute("preflight")}
          />
          {ready && !busy && (
            <Action.SubmitForm title="安装远程补丁" icon={Icon.Download} onSubmit={() => execute("apply")} />
          )}
          <Action.SubmitForm title="查看远程状态" icon={Icon.Info} onSubmit={() => execute("status")} />
          <Action.SubmitForm title="恢复远程原文件" icon={Icon.Undo} onSubmit={() => execute("restore")} />
          <Action.SubmitForm
            title="保存 SSH 与远程配置"
            icon={Icon.SaveDocument}
            onSubmit={() => execute("save")}
          />
          {error && (
            <Action.Push
              title="查看完整错误"
              icon={Icon.ExclamationMark}
              target={
                <Detail
                  navigationTitle="远程操作 · 错误详情"
                  markdown={`# 远程操作未完成\n\n以下为捕获的错误信息，可滚动查看或复制：\n\n\`\`\`text\n${error.replace(/`/g, "\\u0060")}\n\`\`\``}
                  actions={
                    <ActionPanel>
                      <Action.CopyToClipboard title="复制错误信息" content={error} />
                    </ActionPanel>
                  }
                />
              }
            />
          )}
          {error && <Action.CopyToClipboard title="复制错误信息" content={error} />}
          {output && (
            <Action.Push
              title="查看完整输出"
              icon={Icon.Document}
              target={
                <Detail
                  markdown={`# 远程操作输出\n\n\`\`\`json\n${output.replace(/`/g, "\\u0060")}\n\`\`\``}
                />
              }
            />
          )}
        </ActionPanel>
      }
    >
      <Form.Description
        title="支持范围"
        text="CodeBuddy CN 1.106.1 / genie 3.10.0；支持已验证的 8e9c06… / 22e67e… 服务端构建。按实际运行进程选择构建；请保持远程窗口连接。未知构建、无法确定运行构建或摘要不匹配时拒绝写入。"
      />
      <Form.Description
        title={ready ? "版本门禁 · 已通过" : "版本门禁 · 待检测"}
        text={
          ready
            ? `CodeBuddy ${ready.target.appVersion} / genie ${ready.target.extensionVersion}\ncommit: ${ready.target.commit}\n目录: ${ready.target.base}\nPython: ${ready.connection.python}\n资源摘要、注入点和候选语法检查通过。⌘K 可安装；执行时会再次校验，不代表当前会话已经加载补丁。`
            : "先执行「检测目标版本与兼容性」。检测通过前不提供安装操作；版本缺失、未知构建、摘要不匹配或目标不唯一时停止，不修改远端资源。修改任意连接或快捷键配置后须重新检测。"
        }
      />
      <Form.TextField
        id="host"
        title="SSH 目标"
        placeholder="user@example.com 或 ~/.ssh/config 中的 Host 别名"
        value={values.host}
        onChange={(v) => update("host", v)}
      />
      <Form.TextField id="port" title="SSH 端口" value={values.port} onChange={(v) => update("port", v)} />
      <Form.Checkbox
        id="automaticPython"
        title="远端 Python"
        label="自动查找 Python 3.9+（推荐）"
        value={automaticPython}
        onChange={(value) => {
          setVerified(undefined);
          setAutomaticPython(value);
        }}
        info="只读检查 PATH 和常见 Conda 路径，不安装或替换系统 Python。关闭后可手动指定解释器。"
      />
      {!automaticPython && (
        <Form.TextField
          id="python"
          title="Python 路径"
          placeholder="例如 /opt/conda/bin/python3"
          info="填写远端 Python 3.9+ 可执行文件名或绝对路径。"
          value={values.python}
          onChange={(v) => update("python", v)}
        />
      )}
      <Form.Description
        title="认证要求"
        text="使用系统 SSH 配置与密钥 / ssh-agent，BatchMode 非交互认证；请先在终端完成首次连接与主机指纹确认。不收集密码或私钥。本机需 python3，远端需 Python 3.9+；不自动安装解释器。端口默认 22，使用 SSH 别名时也会按本页端口覆盖。"
      />
      <Form.Separator />
      <Form.Description
        title="远程快捷键配置"
        text="配置独立于本机 Raycast 功能设置。远程仅修改宿主和 Webview；编辑器/终端里的新建与聚焦快捷键仍需在本机安装对应绑定，并保持按键一致。"
      />
      <Form.Checkbox
        id="new_chat_enabled"
        title="新建对话"
        label="启用新建对话"
        value={values.new_chat_enabled}
        onChange={(v) => update("new_chat_enabled", v)}
      />
      <Form.TextField
        id="new_chat"
        title="新建快捷键"
        value={values.new_chat}
        onChange={(v) => update("new_chat", v)}
      />
      <Form.Checkbox
        id="stop_enabled"
        title="停止生成"
        label="启用停止生成"
        value={values.stop_enabled}
        onChange={(v) => update("stop_enabled", v)}
      />
      <Form.TextField
        id="stop"
        title="停止快捷键"
        placeholder="esc,esc 或 cmd+alt+."
        value={values.stop}
        onChange={(v) => update("stop", v)}
      />
      <Form.TextField
        id="double_escape_ms"
        title="双 Esc 间隔 (ms)"
        value={values.double_escape_ms}
        onChange={(v) => update("double_escape_ms", v)}
      />
      <Form.Checkbox
        id="focus_enabled"
        title="聚焦输入框"
        label="启用聚焦输入框"
        value={values.focus_enabled}
        onChange={(v) => update("focus_enabled", v)}
      />
      <Form.TextField
        id="focus"
        title="聚焦快捷键"
        value={values.focus}
        onChange={(v) => update("focus", v)}
      />
      <Form.Dropdown
        id="scope"
        title="新建 / 停止范围"
        value={values.scope}
        onChange={(v) => update("scope", v)}
      >
        <Form.Dropdown.Item value="panel" title="聊天面板" />
        <Form.Dropdown.Item value="input" title="仅聊天输入区域" />
      </Form.Dropdown>
      <Form.Description
        title="安装与恢复"
        text="安装会先预检查，再写远端资源；更改配置后须先 Restore 再 Install。备份保留在远端 stable-<commit>/app-hook-studio-remote-backup。两份资源非跨文件事务，中断后先恢复；不结束会话、不自动重启，不修改本机 App。"
      />
      {summary && <Form.Description title="执行结果" text={summary} />}
      {error && <Form.Description title="需要处理" text={error} />}
    </Form>
  );
}
