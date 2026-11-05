# CodeBuddy 批准身份契约 v1

2026-11-05。实现于 host 补丁 v5；批准传输协议仍为 1。此扩展覆盖 App Hook Studio 注入的 `Notification / permission_prompt` 和本机批准 `list.requests[]`，不自动改写原生其他 hook。

## 数据及用途

两处新增同一份可选 `identity`（`schema: 1`），完整类型见 [approval-identity.ts](../src/apps/codebuddy-cn/approval-identity.ts)。原有 `session_id`、`cwd`、`tool_call_id`、`request_id` 和通道字段保留。身份只组织显示，不参与批准路由。

以下为模拟主会话样例，哈希缩写仅用于文档展示：

```json
{
  "schema": 1,
  "machine": {
    "id": "codebuddy:machine:<sha256>",
    "source": "vscode.env.machineId",
    "scope": "codebuddy-installation"
  },
  "workspace": {
    "id": "codebuddy:workspace:<sha256>",
    "source": "vscode.workspace",
    "scope": "host-at-request",
    "kind": "folder",
    "name": "demo",
    "workspace_file": null,
    "roots": [{ "uri": "file:///work/demo", "path": "/work/demo", "name": "demo" }]
  },
  "agent": {
    "id": "session-a",
    "kind": "session",
    "source": "manager.sessionId",
    "session_id": "session-a",
    "session_source": "manager.sessionId",
    "parent_agent_id": null,
    "parent_session_id": null,
    "task_tool_call_id": null
  },
  "cwd_source": "tool-context"
}
```

所有 ID 和路径均按原文、不按显示名称比较；未知值为 null。`cwd_source` 为 tool-context / agent-user-context / unknown；cwd 缺失时通知和列表均为 `""`，不会使用宿主 process.cwd() 补齐。

## 来源、作用域和稳定性边界

### machine

模块 426850 是原生 vscode API 导出。使用 `env.machineId`，输出 `codebuddy:machine:` + SHA-256(JSON.stringify(nativeId))，不输出原始机器标识；不依赖 Hub，也不新建机器身份文件。hostname 和 CLI nodeId 不参与身份计算。

官方将 machineId 定义为机器标识，而 env.sessionId 随编辑器启动变化，因此不使用后者。[VS Code API](https://code.visualstudio.com/api/references/vscode-api#env)

该 ID 作用域明确为 CodeBuddy 安装身份，不声称等于 CLI／Hub nodeId，或跨所有产品、系统重装都相同。原生 machineId 不变时哈希不变；重装清除原生身份可能变化，克隆保留同一原生身份可能重复。跨产品关联需要显式映射，不按 hostname 自动合并。真实 CodeBuddy 重启／重装／配置克隆尚未逐项实测。

API 不可用、ID 缺失或存在 remoteName 时 machine.id 为 null；远端 UI 与 socket 所在机器的对应关系没有验证，因此不把 UI 的 machineId 当本机批准宿主。机器缺失时 workspace.id 同样为 null。

### workspace

读取原生 `workspace.workspaceFile`、`workspace.workspaceFolders`、`workspace.name`。保留所有 roots 的 URI、file scheme 下的 fsPath 和显示名。原生 API 支持保存的 workspace 文件、untitled workspace 及多根目录。[VS Code API](https://code.visualstudio.com/api/references/vscode-api#workspace)

workspace.id 为 `codebuddy:workspace:` + SHA-256(JSON.stringify([machine.id, key]))：

- 有 workspaceFile：key 为 `[kind, workspaceFile.toString()]`，kind 为 workspace-file 或 untitled。
- 无 workspaceFile、有 roots：key 为 `[kind, sortedRootUris]`，单根为 folder，多根为 roots。
- 无 roots 且无 workspaceFile：kind 为 empty，ID 为 null。
- 读取失败：kind/source 为 unknown，ID 为 null。

根 URI 排序仅用于计算 ID，输出顺序保留原生顺序。有 workspace 文件时，增删 roots 不改变该文件代表的工作区 ID；移动 workspace 文件会改变 ID。untitled ID 只在其原生 URI 生命周期内有效。

这是**请求注册时宿主工作区快照**，不是 Git 根、工具 cwd，也不是已经证明的聊天创建时项目根。历史聊天在另一个工作区恢复时，不应据此改写旧历史。后续切换工作区不会改变已注册请求的身份。

URI 使用原生 toString()，不额外小写化、realpath 或移除尾斜杠。保留原生所区分的别名，宁可分别展示，不错误合并符号链接或大小写不同的目录。实际文件系统上是否指向同一目录不在本版保证内。

### agent / session

原生 bundle 的模块 959282 `HookableToolManager.setSessionInfo` 写入 sessionId；`setAgentInfo(name, id)` 写入 agentId。TaskTool.fullExecute 创建 SubagentToolListener 后调用 `setSessionInfo(this.context.conversationId, ...)` 以及 `setAgentInfo(jn.getName(), this.id)`。

因此主会话 `agent.id = session_id`；子任务 `agent.id = manager.agentId`，缺失时回退到 `listener.taskTool.id`，两者都缺失则 null。不为同义 session 额外生成 UUID，也不把子任务的共享 session ID 当作独立子 agent ID。`agent.kind` 区分 session/subagent，子任务 ID 在其父 session 范围内使用。

`session_source` 记录现有四个取值点之一：manager.sessionId、manager.context.conversationId、listener.conversationId、listener.taskTool.context.conversationId。顶层 session_id 的既有选取优先级保留，最后一项明确读取原生 TaskTool.context。

子任务提供 task_tool_call_id；parent_session_id 仅来自 taskTool.context.conversationId。嵌套任务可以共享 conversation，无法从此反推出直属父 agent，故 parent_agent_id 保留 null，不编造根 agent 或父子树。主会话恢复、team member、嵌套子任务的真实生命周期尚待实机验收。

## CoLink 兼容与接入

- 老协议 1 客户端忽略新增字段；新客户端遇到缺失 identity／未知 schema 时显示未归属，仍可通过已验证本机通道操作。
- 推荐持久化组合键为 `[machine.id, workspace.id]`；agent 过滤键附加 `[agent.kind, agent.session_id, agent.id]`。缺失层级不能按名称、cwd 或当前窗口猜测补全。
- 不自动迁移旧 cwd 哈希历史。当前工作区快照不能用来回填历史聊天的创建工作区。
- 只有本机私有目录发现且校验成功的实时请求能触发操作；Hub 中携带的 socket_path 不是连接指令。
- `respond` 请求不变，只使用 request_id 和 action；注入端仍检查原工具状态、轮次、会话管理器及取消信号。改动 identity 不会重新选择目标。
- CLI send-hook 当前会序列化完整 data，故发送端可带上 identity；本地 HookLogEntry 仍不保存该字段。tunnel／Hub 持久化和查询的逐跳保留尚未验证，本轮不更改另一个项目。
- 不配置 Notification hook 仍可获取 list 身份。读取身份 API 失败不阻止批准，能确定的会话身份仍保留。

## 验证与交付

[共享模拟样例](../tests/fixtures/codebuddy-identity-v1.json)包含不同机器同路径、同名不同路径、多 session、多窗口、两个子任务、缺失机器、空窗口、多根及顺序变化。name 标识场景，workspace_group 为预期等价类而非线上 ID。

[身份测试](../tests/approval-identity.test.ts)覆盖样例分组、工作区切换快照、保存／untitled、多根、大小写保留、远端与 API 缺失；[通知集成测试](../tests/approval-hook.test.ts)用真实 Unix Socket 验证 hook/list 的完整 identity 相等，并模拟原生 cwd 回退以验证覆盖。现有三个动作与过期路由测试保持通过。

v1/v2/v3/v4 安装资源均可校验并升级到 v5，保留原文备份和精确恢复能力。v4 渲染器冻结保存，拒绝覆盖非预期修改。真实包完整语法和迁移测试与模拟运行测试分开。

以上是代码与自动化验证结果，不是全部原生 UI 生命周期实测。实际安装仍需更新 App Hook Studio 后整体 Install 并重启 CodeBuddy；本次开发没有修改已安装 CodeBuddy、用户 hooks 或启动后台服务。

## host v6：显示信息与 Session 对象

v6 保留所有 v5 身份键与 protocol=1 / identity.schema=1，新增可选字段：

- `machine.display_name` / `display_name_source`：本机扩展宿主的 `node.os.hostname()`（bundle 模块 370857）。仅显示用途，不参与 machine.id 或工作区哈希；remoteName 存在时留空，避免把远端 hostname 标成本机 PC。不是 macOS 系统设置中的 ComputerName，也不等同 Hub node ID。
- `session`：id 与原请求 session_id、agent.session_id 相同；title 来自已初始化的原生 ConversationManager.conversationMap 中同 ID 元数据的 name。模块 302351 导出 ConversationManagerToken（Symbol 名为 ConversationManager）；实现模块 819885 的 getConversation(id) 正是读取该 Map。原生 ChatStateSyncListener（66180）也使用 getConversation(id).name 作为会话标题。
- `session.title_source` 为 `ConversationManager.conversationMap.name`；`title_observed_at` 为读取时刻，而非原生修改时间。无标题、未初始化、无缓存时均为空；不访问当前焦点会话、不读取 transcript、不以提示词代替标题，也不延迟批准回调。
- `observed_at` 为身份采集时刻。所有时间仅输出有限且非负的 Unix 毫秒，否则 null。
- `diagnostics` 为可选字符串数组。会话缓存 ID 不一致输出 SESSION_METADATA_ID_MISMATCH，标题为空；不可读时输出 SESSION_METADATA_UNAVAILABLE；机器名称读取失败输出 MACHINE_DISPLAY_UNAVAILABLE。这些诊断可在请求详情看到，不阻止批准。

每轮注册只保存一次快照。聊天改名影响后续新请求，不刷新旧请求或旧历史；同名不同 session 仍分开。直属父 agent 仍可能未知，不以 session ID 编造父子树。

[JSON Schema](../schemas/codebuddy-identity-v1.schema.json) 验证 v5/v6 结构；跨字段 session ID 一致性由运行时检查（JSON Schema 不表达该相等约束）。[共享显示样例](../tests/fixtures/codebuddy-display-v1.json) 是明确标记的模拟数据，涵盖改名、同名不同 ID、空标题、丢失元数据与冲突，不是原生会话录制。

CoLink 已补充可选字段读取：本地别名优先，其次原生显示名称，再降级为未知名称/ID；新 session.id 冲突时弃用新对象并保留诊断，agent.session_id 与请求冲突则身份未归属。只以 observed_at 选择可展示快照，不称之为最新原生修改版本，也不改写审计记录。

### 验收状态

自动化：身份旧字段键保持不变、v5/v6 schema、主/子会话关联、同名不同 ID、改名快照不变、缺失/空白标题、非法时间、元数据冲突、远端名称留空、真实 Socket 的 hook/list 快照一致，以及 v1–v5 资源识别和 v6 完整语法验证。CoLink 覆盖降级、冲突不改归属、名称读取和历史序列化快照。

待实机：原生聊天重命名/恢复/重启后的 ID 生命周期、嵌套与 team member 会话、原生 UI 展示及脱敏原生事件样例。源码证据和模拟测试不代替这些结果。本次未修改已安装应用、用户 hooks，也没有启动后台服务。CLI 摘要、Hub/tunnel 逐跳保留及远程批准仍是独立交付范围，不宣称已完成。
