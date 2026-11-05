# CoLink 身份分层探索需求

日期：2026-11-05
状态：待 App Hook Studio 探索验证；不是已确认的协议设计。
需求方：同级目录 `../colink` Raycast 插件。

## 目标

为 hook 事件和本机批准协议提供可靠的三层归属：PC 机器 → 工作区 → agent-id（产品语义相当于 session id）。CoLink 据此隔离工作区 UI、待确认工具与操作历史。请在注入端探索真实字段来源、稳定性和生命周期，给出证据及可实施的契约，不能只从显示名称或工具参数猜测。

## 当前情况

- CoLink 使用 Unix Socket 协议 1 获取实时待确认请求，当前有 `cwd`、`session_id`、`tool_call_id`、`request_id`、通道 `window_id`。
- 当前注入实现将 `info.cwd || ""` 返回为 `cwd`。尚未确认它是稳定项目根，还是可随工具变化的工作目录。
- CoLink 暂按完整 cwd 分组，历史按路径哈希分目录；这只是过渡方案。
- 已有 colink CLI 从 hook 的 cwd / workingDirectory / working_directory 提取会话 projectPath；不代表所有事件都带有路径，也不代表已验证项目根语义。
- window_id 是宿主通道身份，不作为机器、工作区或 agent 身份。

## 请探索的问题

### PC 机器

1. 哪个字段能稳定区分 PC，跨应用重启、窗口重载仍保持一致？是否可复用 code-agent-link 的 node/device 身份？
2. 本机离线时如何获得身份？Hub 未连接时不能阻塞本机批准。
3. hostname 只作显示名称，不单独作唯一键；明确重装、迁移、克隆配置时的行为。
4. 同路径出现在不同机器上时必须隔离。远端事件只读，不据其 socket_path 连接本机。

### 工作区

1. 从 CodeBuddy 原生 workspace / project 上下文提取稳定 project path；明确与工具 cwd、Git 根目录的区别。
2. 验证单目录、多根工作区、无文件夹窗口、目录切换、符号链接、尾斜杠和大小写的行为。
3. 多根工作区是否需要 workspace_id + roots，而非强制压成单一路径？路径原文与用于比较的规范值如何表达？
4. 路径缺失时明确 unknown，不把空字符串、工具参数路径或焦点窗口当作可靠归属。

### agent-id / session id

1. 确认 session_id 是否就是产品所需 agent-id，来源和唯一性范围是什么；不要未经验证再生成一套同义 ID。
2. 验证新建聊天、恢复历史聊天、窗口重载、并发会话、主会话和子任务的生命周期。
3. 子 agent 是否有独立 ID、parent_agent_id，以及根会话 ID？避免不同子任务被错误合并。
4. request_id 继续表示单轮批准身份，tool_call_id 表示工具实例；都不能代替 agent-id。

## 输出要求

- 给出字段来源与对应代码位置、脱敏样例，以及上述场景的实测结果。
- 提议统一身份 envelope（字段名待探索确定），至少说明 machine、workspace、agent/session 的 ID、显示信息、可空性、作用域和稳定性。
- 说明这些字段如何同时进入 hook payload 与批准 list 响应，以及现有 CLI、本地摘要日志和可选 Hub 是否完整保留。
- 提供协议 1 的兼容扩展或必要的版本升级方案；旧客户端遇到缺失身份字段的降级行为要明确。
- 提供双方可共用的 fixtures：不同机器同路径、同机器同名不同路径、同工作区多 session、多窗口、子任务、缺失身份、切换工作区后的旧请求。
- 保持最终批准仍由注入端按 request_id 和原会话归属校验；展示身份不能改变批准目标。

## CoLink 后续接入标准

1. UI 按机器 / 工作区组织，工作区内合并待确认和操作历史，可进一步按 agent/session 过滤。
2. 持久化键包含机器和工作区身份，历史保存 agent/session 和请求身份，不默认落盘完整工具参数。
3. 旧记录无法可靠补全身份时保持未归属，不按路径简称或当前窗口自动迁移。
4. 未完成契约验证前，不声称 cwd 就是 project root，或 window_id 就是 PC / workspace 身份。

本需求仅安排探索与契约设计，不授权自动修改已安装 CodeBuddy、现有 hooks 或启动持久后台服务。完成后请将结论回填本文或关联调查文档，供 CoLink 对接。

## 首轮源码核查（2026-11-05）

状态：以下为现有源码证据，尚未完成原生字段生命周期实测，也不是已发布的身份契约。

| 字段／链路   | 已确认的实现                                                                                                                                                                   | 对接影响                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `nodeId`     | `code-agent-link/apps/cli/src/commands/send-hook.ts:241` 默认 `hostname()`；显式 `--node-id` 覆盖，否则保留 payload 已有字符串                                                 | 不能直接当成稳定 PC 唯一键；需继续核查持久 device/node 身份                      |
| `cwd`        | [approval-runtime.ts](../src/apps/codebuddy-cn/approval-runtime.ts:32) 取 `manager.getContext().workingDirectory`，回退到 agent 的 `getUserContext().env.workspace`            | 是混合来源，尚未证明为原生 workspace 根；需要分别记录来源                        |
| `session_id` | [approval-runtime.ts](../src/apps/codebuddy-cn/approval-runtime.ts:29) 依次取 manager.sessionId、context.conversationId、listener.conversationId、taskTool.getConversationId() | 现有回退链不能证明主／子 agent 一一对应，不能直接发布 agent-id 等价保证          |
| `window_id`  | [approval-control-runtime.ts](../src/apps/codebuddy-cn/approval-control-runtime.ts:7) 在初始化时生成随机 UUID                                                                  | 只表示通道实例；重载后变化                                                       |
| 缺失路径     | 注册请求先于路径检查；list 返回空 cwd，Notification 因缺失 workspace 报错后不发送                                                                                              | hook 与实时列表覆盖范围可能不同；身份缺失不能导致新契约丢掉本机待办              |
| hook 上报    | `send-hook.ts:265` 序列化完整 `data`，并注入 nodeId                                                                                                                            | CLI 此段可携带新增 envelope；不代表 tunnel／Hub 存储和查询全程保留，仍需逐跳验证 |
| 本地摘要     | `send-hook.ts:286` 和 `services/hook-log.ts:33` 只列举摘要字段                                                                                                                 | 新 identity 不会自动进入摘要；需要独立兼容扩展                                   |

上述 code-agent-link 路径相对于同级上层项目 `../../code-agent-link`。本轮只读源码，未收集真实聊天内容或修改安装。

### 契约探索方向（待验证，不能据此实现强身份分组）

- 在协议 1 的请求及 hook payload 中增加可选 `identity`，内部单独带 schema 版本；原有 cwd、session_id、request_id 和通道字段保持语义。改变动作寻址或要求客户端新增必填字段时才考虑批准协议升级。
- machine、workspace、agent 三层各自表达 ID、来源与可空性；“未知”使用明确空值，不用 hostname、空路径或当前窗口补齐。显示名与比较键分离。
- 机器身份优先调查既有本机持久身份的所有者和创建方式。若不存在合适身份，再提议离线生成并持久保存的安装 UUID；必须说明多进程首次创建、重装、配置迁移和克隆的行为，不能承诺克隆后仍天然唯一。
- workspace 保留原生 URI／roots 与原始路径；规范化策略先验证文件系统大小写、符号链接和多根 workspace 语义，不先做小写化或强制 realpath 合并。工具 cwd 单独保留。
- agent 优先复用已验证的原生 session ID；parent/root 只有存在可靠原生关联时才填，不能从工具名称或列表顺序推断。
- identity 在请求注册时快照，后续工作区切换不得把旧请求重新归属到当前工作区。最终动作仍按注入端捕获的请求和原会话校验；identity 只用于组织展示，不成为批准路由替代物。
- 旧客户端忽略新增字段；新客户端遇到缺失／未知身份 schema 时保留本机实时批准能力，显示“未归属”，不跨机器按 cwd 合并。旧历史不猜测迁移。远端事件仅只读，不连接其 socket_path。

### 后续交付及验证门槛

1. 为每个候选字段补齐原生 bundle 模块、读取点、创建／恢复／销毁位置和脱敏样例；特别追踪上述 session 与 cwd 回退链的每一分支。
2. 建立实测表，逐项覆盖需求中的重启／重载、单根／多根／无目录、目录切换、符号链接／大小写、新建／恢复／并发聊天及子任务。每项明确“源码推断／模拟测试／实机验证／未验证”，不可相互替代。
3. 给出 hook → CLI → tunnel／Hub → 查询及本地摘要的字段保留表，注明需要改动的组件；不能只验证发送端就声称全链路可用。
4. 提交双方可复制的版本化 JSON fixtures 和预期分组／动作行为：不同机器同路径、同名不同路径、多 session、多窗口、主子任务、缺失身份、切换工作区后的旧请求；样例必须标明模拟或实测脱敏来源。
5. 验证旧协议 1 客户端读取新响应、新客户端读取旧响应、未知 identity 版本，以及重复提交／旧请求拒绝等原有批准约束。身份功能失败不得阻塞原生 CodeBuddy 确认流程。

完成以上证据与验证后，再发布字段定义和 CoLink 接入结论。本轮未修改 CoLink 的分组实现、已安装 CodeBuddy 或现有 hooks。

## 实现进展（host v5）

已实现通知与批准列表的可选 identity.schema=1，具体字段、来源、作用域、兼容行为和验证状态以[身份契约](codebuddy-identity-contract.md)为准。上文首轮发现保留为调查记录；缺失 cwd 导致通知跳过的问题已修复，并显式覆盖原生 NotificationManager 的 process.cwd() 回退。

源码进一步确认子任务的 sessionId 复用父聊天，而 manager.agentId 来自 TaskTool.id，因此分别输出 agent 与 session。workspace 为请求注册时原生宿主快照，尚不宣称历史聊天创建归属；直属 parent_agent_id 未确认则为空。机器使用原生 env.machineId 的带命名空间哈希，不复用 hostname。

自动化覆盖身份分组、快照、缺失字段、hook/list 一致性及旧资源升级；原生重启、恢复聊天、嵌套任务、配置克隆等实机矩阵仍待验证。没有修改已安装应用、现有 hooks 或另一个项目的日志协议。

## 后续需求：Session 标题（2026-11-05）

CoLink 已按 PC → Workspace → Session → 请求与历史展示。同一 session_id 的主会话与子任务请求聚合；子 agent 身份继续保留。当前契约没有会话标题，CoLink 临时支持以机器/工作区/session ID 为键的本地显示名称。

请探索原生会话 title 的可靠来源，提供可空标题、来源以及改名/恢复聊天后的更新行为。title 仅用于审计显示，唯一键仍为 session ID；不能从单个工具 command/explanation 推断标题。并请探索 PC 显示名称的可靠来源，machine ID 不变，不用 hostname 替代唯一身份。未知值留空，本地别名与原生标题应分别存储。

完整后续对接约定见 [CoLink 对接协议](colink-integration-contract.md)，区分 v5 已实现基线与待实现的 Session/title/PC 显示名扩展。
