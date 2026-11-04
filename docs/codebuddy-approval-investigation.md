# CodeBuddy 工具等待用户批准的 hook 点位

2026-11-04 对本机 `/Applications/CodeBuddy CN.app` 做包内静态分析。这里的“鉴权”指工具执行前等待用户批准，不是账号登录。

## 资源与协议

- 扩展：genie 3.10.0。
- 资源：`Contents/Resources/app/extensions/genie/out/extension/index.js`。
- 本次读取资源 SHA-256：`b593c8ede94793f88501af98b54cb391cb1beed0ec6d690f174bf32f1f2e0e5d`。这是本机当前资源摘要，不能当作未修改原文的摘要；现有焦点桥也修改此资源。
- Webview 快捷键使用的 `ChatInput` 注入位置不适用于这里；批准状态与 hook 执行器在扩展端。

包内模块 `946785` 定义 `HookEvent.NOTIFICATION = "Notification"` 和 `NotificationType.PERMISSION_PROMPT = "permission_prompt"`。当前枚举没有 `PermissionRequest` hook 事件。

模块 `176998` 的 `NotificationManager.notifyPermissionPrompt()` 已构造对应通知，但全文仅找到这一个方法定义；`notificationManager` 无命中。这支持“已有协议实现、未发现接入调用”的静态结论，不代表运行时验证。

## 推荐插入点

模块 `73280` 的 `ToolManagerListener`：

```js
async onUserConfirmRequired(ir, ar, tn, rn) {
  // ar: toolCallId；tn: tool instance
  // this.conversationId: 当前会话 ID
  // 原代码随后设置 pendingConfirmation，并转入 WAITING_USER_INPUT。
}
```

唯一方法头锚点：

```js
async onUserConfirmRequired(ir,ar,tn,rn){var nn,sn,dn,gn,yn,En,bn,wn,Rn;
```

建议在原代码完成 `pendingConfirmation: true` 和 `WAIT_USER_INPUT` 状态更新后、等待批准前发通知。这里表示已经进入用户确认流程，比工具元数据 `needUserConfirm` 或 `PreToolUse` 更接近目标时刻。

原调用链：

```text
ToolManagerListener.onUserConfirmRequired
  → setPendingDialogTool(..., true)
  → updateToolInfo(..., {pendingConfirmation: true, ...})
  → session.transition(WAIT_USER_INPUT)
  → persistCurrentMessageForRecovery
  → 非 safetyConfirmMessage 分支：AcpAgent.handleToolApproval
  → connection.requestPermission
  → 等待 allow / allow_always / skip / reject 等结果
```

`handleToolApproval()` 内部有重试循环，因此不要在循环里的 `requestPermission()` 前无去重地发送通知。也不要只挂在 `handleToolApproval()`：上层用 `safetyConfirmMessage` 排除了安全确认路径，会漏事件。

`showToolPermissionNotification()` 是系统通知路径，还受 `chatModeSettings` 的 autoRun / autoModify 条件影响，不宜作为统一 hook 点位。

## 复用 CodeBuddy hook 协议

现有通知执行器最终调用：

```js
hookManager.executeHooks("Notification", {
  hook_event_name: "Notification",
  notification_type: "permission_prompt",
  session_id,
  transcript_path,
  cwd,
  message,
  generation_id,
  model,
  client,
  version,
});
```

以上字段来自包内真实实现；`tool_name`、`tool_input`、`tool_call_id` 不在该通知实现的标准 payload 中。v4 hack 为外部批准增加 `request_id`、`tool_call_id`、`tool_name` 和 `approval_channel` 扩展字段，见[外部批准协议](codebuddy-approval-control.md)。

模块 `73280` 中 `sn` 是 `tn(932708)`，提供 `ContainerUtil`；hook token 来自 `tn(946785).HookManager`。可以沿现有 IoC 获取执行器：

```js
// 注入方式示意，尚未安装或运行验收。
const manager = sn.ContainerUtil.get(tn(946785).HookManager);
// 注意：在 onUserConfirmRequired 方法里，形参 tn 遮蔽了模块 require tn！
// 因此上面获取 token 的表达式必须放在模块作用域，或先捕获 require/token。
```

实际实现应在模块作用域捕获 token，再在方法内调用。不能把这行直接粘到方法里。也可以在模块作用域捕获 `tn(176998).NotificationManager`，复用其 payload 构造。

会话、工作目录、transcript 和 generation 等字段须沿当前 agent/context 获取并验证，不能把 `process.cwd()` 默认当作用户项目目录。通知异步失败应被捕获并记录，不应中断原批准流程；通知返回值不应代替用户批准。按会话、toolCallId、确认轮次去重，结束等待后释放，避免同一工具再次确认时被永久抑制。

`HookManagerImpl.executeHooks()` 会用 `notification_type` 匹配 Notification hook，因此可配置 `permission_prompt` matcher。这里应复用现有配置加载、命令执行和超时机制，不另建 shell 执行通道。

## 子任务与例外

另有 `SubagentToolListener.onUserConfirmRequired()`，维护 `confirmRoundMap` 并更新 `needApprove: true`。如果目标包括子任务工具，应接入此路径，并以实际确认轮次去重；仅主会话点位不保证覆盖子任务。

另一个 GenPlan listener 的同名方法会直接 `confirmToolExecution(ar, true)`，并不等待用户。不能对所有同名方法一律插通知。

## 验证与落地范围

现已实现于 `src/apps/codebuddy-cn/approval-runtime.ts`，由 `focus-host.ts` 的 v4 共享补丁在扩展激活时安装 listener 包装器；保留原方法返回值与 Promise，不等待通知完成。主会话与子任务使用各自 ToolManager 的 session、transcript、generation、model 和工作目录；没有工作目录时记录错误并跳过，避免使用扩展宿主目录。转发的父 Task 确认由子任务点位负责，避免重复。弱引用记录待确认实例，确认时间变化或开始/完成执行时允许下一轮，扩展卸载恢复原方法。

Raycast 内置功能 `approval-notification` 随整个 App 安装，无独立快捷键设置。动作通过 CodeBuddy 自身 hooks 配置控制。与聚焦功能共享同一个 host adapter、备份目录和单次写入；支持识别并升级旧 v1/v2/v3 桥。安装器在写入前验证资源摘要、唯一锚点和完整 JS 语法，恢复时精确还原两份资源。MCP `list_apps` / `get_app` 自动发现内置功能，`preflight_app` 返回对应目标和共享安装计划。

在 CodeBuddy 已使用的 hooks 配置中合并如下结构，替换命令为自己的通知程序（通过标准输入读取 JSON）：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "^permission_prompt$",
        "hooks": [{ "type": "command", "command": "/absolute/path/to/notify-approval", "timeout": 10 }]
      }
    ]
  }
}
```

不配置匹配 hook 时不会执行通知命令；该通知不读取返回值来决定批准或拒绝。

VM 和临时 `.app` 测试覆盖通知错误隔离、重复确认、多轮确认、并发会话、子任务、卸载、原返回值、旧桥升级、共享资源只安装一次及字节恢复。批准通知点位已由用户实测确认有效；新增外部批准动作尚待真实模型会话验收。

运行验收至少覆盖：普通工具确认、安全规则确认、自动允许不发通知、拒绝直接终止不发等待通知、ACP 重试不重复、子任务多轮确认、通知失败仍能正常批准和取消会话。静态搜索无法证明这些路径在真实模型会话里的表现。
