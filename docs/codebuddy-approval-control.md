# CodeBuddy 外部工具批准

内置功能 `approval-control`（外部工具批准）提供本机 Unix Socket 通道。外部程序可查询当前等待确认的工具，再按本轮 `request_id` 提交 `allow`、`reject` 或 `skip`。它不调整自动批准策略，也不支持 `allow_always`。

## 安装与使用

运行 `npm run install:local` 更新 Raycast 插件，在 Manage App Hooks → CodeBuddy CN 中可见此功能。完全退出 CodeBuddy 后整体 Install，再重新打开。已安装 v1/v2/v3 的扩展桥会升级为 v4；聚焦、批准通知和外部批准共用一次资源写入和同一原文备份。恢复整个资源补丁会一并移除通道，随后重启应用生效。

在项目目录使用：

```sh
npm run approval -- list
npm run approval -- allow <request_id>
npm run approval -- reject <request_id>
npm run approval -- skip <request_id>
```

列表包含会话、工具名称和输入、确认原因、工作目录、窗口与通道信息。每次操作只使用一个从当前列表或通知取得的 `request_id`。返回 `submitted` 表示决定已交给原应用处理，不代表工具已执行成功。

MCP 也提供：

```json
{"tool": "list_pending_approvals", "arguments": {}}
{"tool": "respond_to_approval", "arguments": {"requestId": "<request_id>", "action": "allow"}}
```

`respond_to_approval` 是运行时操作；`allow` 可能立即执行对应工具。安装与恢复仍在 Raycast 进行，MCP 的 Recipe 注册不会修改此内置实现。客户端需重新连接更新后的 MCP 服务才能发现新增工具。

## 通知与通道协议

原有 `Notification / permission_prompt` payload 保留，并增加以下扩展字段：

```json
{
  "request_id": "<每轮确认随机生成的 UUID>",
  "tool_call_id": "<应用工具调用 ID>",
  "tool_name": "Bash",
  "approval_channel": {
    "protocol": 1,
    "transport": "unix",
    "socket_path": "/tmp/ahs-codebuddy-<uid>/<pid>-<随机值>.sock",
    "window_id": "<本次扩展激活的随机 UUID>"
  }
}
```

这些是 App Hook Studio 扩展字段，不是原版 CodeBuddy 通知协议的必填字段。通知命令仍由 CodeBuddy 原有 hooks 配置决定；没有配置 Notification hook 时，外部查询和操作通道仍可使用。

每个扩展宿主实例创建独立 socket 和 `.sock.json` 发现文件。目录权限为 `0700`，socket 和发现文件为 `0600`，仅同一系统用户访问；不监听 TCP。多窗口客户端聚合各个发现文件，不使用“当前焦点窗口”或模糊的工具名称来匹配。

一条连接接收一行 JSON，返回一行 JSON，随后关闭。例如：

```json
{"protocol":1,"op":"list"}
{"protocol":1,"op":"respond","request_id":"<request_id>","action":"skip"}
```

成功结果：

```json
{ "protocol": 1, "ok": true, "status": "submitted", "request_id": "<request_id>", "action": "skip" }
```

列表返回 `window_id` 和 `requests` 数组。失败返回 `ok: false` 与 `error.code`、`error.message`。常见错误包括：

| code                 | 含义                                                       |
| -------------------- | ---------------------------------------------------------- |
| `NOT_READY`          | ACP 正在保存恢复数据，尚未建立批准等待对象；可重试同一请求 |
| `NOT_PENDING`        | 已在 UI 回应、工具结束、会话取消、确认轮次变化或已过期     |
| `ALREADY_RESOLVED`   | 此请求已向应用提交过决定                                   |
| `TARGET_CHANGED`     | 会话或工具管理器已不再拥有该确认对象                       |
| `UNSUPPORTED_TARGET` | 特殊 detached 路由不支持此操作，请使用原 UI                |
| `INVALID_ACTION`     | 动作不在 allow / reject / skip 白名单中                    |

客户端每次先重新发现并查询目标，再发送操作；服务端在执行前再次检查实例、待确认状态、确认时间和会话取消信号。请求在操作前即被消费，避免重入或重复点击。运行中注册表最长保留 30 分钟；应用自身的取消、超时和 UI 回应可以更早使其失效。崩溃残留的发现文件会被标为 unavailable，不会被客户端接管或删除。

## 原应用调用路径

- 普通主会话 ACP：调用 `AcpAgent.respondToPermission(toolCallId, approved, false, isSkip)`，唤醒已有 Promise，继续原 listener 的状态恢复、确认或取消流程。等待对象尚未就绪时不绕过 ACP。
- 主会话安全确认或非 ACP 确认：确认当前会话仍持有捕获到的工具管理器与实例，然后调用原 `ToolService.execute / cancel / ignore`，保留 UI 状态、会话状态与持久化更新。
- 子任务：对捕获的工具管理器调用 `confirmToolExecution` 或 `skipToolExecution`，保留原任务 listener 的状态更新。不会通过全局 SubagentManager 广播工具 ID。

特殊 detached 确认中，普通 ACP 路径仍复用原批准响应；非 ACP 主会话以及无法精确匹配 active instance 的子任务 skip 返回 `UNSUPPORTED_TARGET`，不猜测操作其他实例。

扩展卸载会关闭 socket、断开连接、删除自身发现文件并还原被包装的方法。恢复磁盘资源后，需要重启应用才能卸载已加载的运行时代码。

## 验证边界

测试覆盖真实 Unix Socket 往返、权限、多窗口发现与路由、三个动作映射、ACP 就绪竞态、UI 回应后失效、多轮确认、取消、重复操作、通知中的结构化 ID、卸载清理，以及真实包资源的 v1/v2/v3 升级、完整语法校验和字节恢复。工具执行路径使用应用接口 mock 验证；尚未在真实模型会话逐项验收允许、拒绝、跳过。先前批准通知点位已由用户实测确认有效。
