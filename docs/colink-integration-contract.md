# CoLink ↔ App Hook Studio 对接协议

日期：2026-11-05。状态：v5 基线 + v6 可选扩展已实现，原生生命周期实测待完成。

## 1. 生效范围

当前生产基线为 App Hook Studio host v5、批准传输 protocol=1、identity.schema=1。现有事实以 App Hook Studio 的 `docs/codebuddy-identity-contract.md` 为准。本文新增的 session、机器显示名及时间字段已在仓库 host v6 实现并自动化验证；不代表已安装宿主已升级，也不代表原生生命周期已实测。

App Hook Studio 负责原生字段探索、注入与批准校验；CoLink 负责展示、用户决定、历史隔离与审计。身份用于组织信息，不能改变批准目标。本文不授权修改已安装应用、安装 hooks 或启动后台服务。

## 2. 产品层级与唯一键

UI 导航为 **Workspace → Session → 请求与历史**。PC 是工作区列表上的身份标签，不设独立 PC 一级页面；标签显示本地别名或短 ID，可查看/复制完整机器 ID。不同 PC 的工作区即使同名同路径，也按机器与工作区组合键分开列出。下表为身份关系，不代表 UI 导航层级。

| 层级      | 唯一键                                 | 显示信息                         | 语义                                                 |
| --------- | -------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| PC        | machine.id                             | 本地别名、原生显示名、ID         | CodeBuddy 安装身份，不等同 Hub node ID               |
| Workspace | [machine.id, workspace.id]             | 名称、所有根路径、workspace 文件 | 请求注册时宿主工作区快照                             |
| Session   | [machine.id, workspace.id, session.id] | 本地别名、原生 title、ID         | 原生聊天会话；同一会话的请求和历史聚合               |
| Agent     | [Session 键, agent.kind, agent.id]     | 类型、ID                         | Session 内主代理或子任务，作为请求属性和可选过滤条件 |
| Request   | 本机已校验通道身份 + request_id        | 工具、原因、输入、时间           | 单轮批准，不复用旧 ID                                |

所有 ID 原文比较，显示名称不参与键计算。Session 跨工作区出现时仍按工作区快照隔离，不自动合并历史。子任务共享同一 session 时聚合展示，仍保留独立 agent ID；未知直属父 agent 不编造父子树。

## 3. 字段契约

### 已实现：identity.schema=1

- machine：id / source / scope。id 可空；scope 为 codebuddy-installation。
- workspace：id / source / scope / kind / name / workspace_file / roots。
- agent：id / kind / source / session_id / session_source / parent_agent_id / parent_session_id / task_tool_call_id。
- cwd_source：tool-context / agent-user-context / unknown。
- 原请求 session_id、cwd、request_id、tool_call_id 继续保留。

workspace.scope=host-at-request，不保证是聊天创建时工作区。cwd 是执行上下文，不用来填补 workspace ID。machine ID 不能证明网络来源可信，也不保证配置克隆后唯一。

### host v6 已实现：schema=1 的可选扩展

```ts
interface IdentityDisplayExtension {
  // 在现有 machine 内追加；不改变 id/source/scope。
  machine: {
    display_name?: string | null;
    display_name_source?: string | null;
  };
  // 独立 Session 对象，现有 agent.session_id 保留用于旧客户端。
  session?: {
    id: string;
    title: string | null;
    title_source: string | null;
    title_observed_at: number | null; // Unix 毫秒，读取标题时刻
  };
  observed_at?: number | null; // 身份快照采集时刻，Unix 毫秒
}
```

上例是扩展片段，不是完整 identity，可选字段缺失不影响旧字段。未知值为 null 或缺省，空白 title 视为未知。时间必须有限且非负；无法确定时留空，不伪造原生修改时间。

session.id 必须与原请求 session_id、agent.session_id 一致；上游发现不一致时须明确调查并输出诊断，CoLink 不采用冲突的新 session 对象重分组。会话标题只能来自已验证的原生聊天元数据，不能用 tool command、explanation、cwd 或首个工具名称代替。

若真实原生语义需要改变既有字段，应另行升级 identity schema，并提供迁移方案；不能用可选扩展名义改变旧字段含义。

## 4. 标题、别名与历史

显示优先级：用户本地别名 → 已验证的非空原生标题/机器显示名 → 未命名会话/PC 短 ID。完整 ID 始终可查看和复制。本地别名独立保存，不回写 CodeBuddy，不覆盖原生标题字段。

请求 identity 是注册快照。用户重命名聊天后，不要求修改旧请求快照。若要显示最新标题，需单独验证只读 session 元数据查询或事件更新能力；在实现前不得承诺实时同步。

历史保存提交时 identity、session ID、标题快照、请求 ID、决定、提交时间与明确响应；标题改名不改写已有审计记录。最新显示缓存与历史快照分开，不能把 observed_at 当作原生标题修改版本。

历史键按机器和工作区隔离，Session 内展示该 Session 的记录；缺失层级明确未归属，不按 cwd、hostname、焦点窗口或同名项目补全。旧 cwd 哈希历史不自动迁移。完整工具输入默认不落盘。

## 5. 传输、兼容与安全边界

- 批准 list 与 Notification / permission_prompt 共享相同注册快照；protocol 保持 1。
- respond 仍只发送 protocol/op/request_id/action，提交前重新查询已发现私有通道，最终由注入端校验。
- 旧客户端忽略扩展字段；新客户端缺少 session 时使用现有 agent.session_id / 原请求 session_id，标题显示未知。
- 未知 identity schema 或无效身份字段进入未归属；不因此改写目标或绕过批准校验。
- 本地 hook 摘要日志当前不保留 identity；CLI 完整 payload 可携带不等于日志、Hub、tunnel 全链路已经保留。逐跳验证属于独立交付项。
- 远程 PC 接入需另行设计认证、授权、节点身份映射和批准路由。远端 socket_path 仅作数据，不能作为本机连接指令；当前 CoLink 只操作经本机私有目录发现和校验的 Socket。
- 不将当前机器列表 UI 表述为已经支持远程批准。

## 6. 上游交付与验收矩阵

App Hook Studio 提交：字段来源和原生代码位置、脱敏原生样例、类型和 schema、共享 fixtures、更新后的身份契约，以及自动化和实机结果分开记录。

| 场景                                 | 预期                                          |
| ------------------------------------ | --------------------------------------------- |
| 不同 PC、相同路径和 session ID       | PC、工作区、历史分别隔离                      |
| 同 PC、同名不同路径                  | 不合并工作区                                  |
| 同工作区、两个 session               | 两个会话入口，名称与完整 ID 可审计            |
| 同 session、多个工具请求             | 聚合在一个会话内，各 request ID 独立批准      |
| 同 session、主会话与多个子任务       | 同会话聚合，agent ID 独立，未知直属父节点为空 |
| 同名 session、不同 ID                | 分开显示，不按 title 合并                     |
| session 改名、恢复聊天、重启         | ID 稳定性实测；旧历史标题快照不变             |
| 请求注册后切工作区                   | 旧请求和历史保留注册快照                      |
| 缺失标题、旧 v4/v5、未知 schema      | 可解释地降级，不猜测身份                      |
| 多根、untitled、空工作区、remoteName | 按既有边界处理，不能误认成本机项目根          |
| session.id 与旧字段冲突              | 诊断可见，不用冲突身份重新归组                |

CoLink 当前已实现：Workspace/Session 导航和 PC 身份标签、同 session 请求与历史聚合、本地 PC/Session 别名、单条历史删除。原生 title 与 PC 显示名已接入可选 v6 字段；原生生命周期和 UI 仍待实机验收，远端接入仍未实现。不能以本地别名代替这些项目的验收。

## 7. v6 实施补充

机器显示名来自本机扩展宿主 node.os.hostname（仅显示，不作为身份）；存在 remoteName 时留空。Session 标题来自原生 ConversationManager 已初始化的 conversationMap[id].name，严格核对元数据 ID。空白标题、无缓存或未初始化时留空，不异步阻塞批准或查询当前焦点聊天。

可选 diagnostics 数组公开 SESSION_METADATA_ID_MISMATCH / SESSION_METADATA_UNAVAILABLE / MACHINE_DISPLAY_UNAVAILABLE。CoLink 新 session.id 冲突时保留旧 ID 并忽略冲突对象；旧 agent.session_id 与请求冲突时降级未归属。诊断在请求详情中可见。

字段证据、JSON schema、共享显示 fixtures 与自动化/实机分界见 App Hook Studio 的 docs/codebuddy-identity-contract.md（host v6 章节）。两仓库 tests/fixtures/codebuddy-display-v1.json 内容同步。原生重命名、恢复聊天、重启、嵌套任务的实机矩阵及脱敏原生样例尚未完成；禁止以模拟样例冒充实测。
