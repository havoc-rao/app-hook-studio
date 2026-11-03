# Code-agent recipe：统一映射与安装契约

**状态：旧 v1 设计稿。本文及附带 JSON Schema、recipe、bridge 不可直接导入执行。** 已实现的本地 MCP 与 `dom-keyboard/v1` 使用独立的可执行 Recipe v2，见 [MCP 使用说明](../mcp.md)。CodeBuddy 的 React 私有回调仍来自内置 `AppAdapter`。本设计描述下一步如何让 code-agent 的分析结果成为可审阅、可校验、可安装的输入，而不是要求用户修改核心代码。

## 要统一的关系

```text
应用身份 → 构建 profile → 资源文件 → 安装位置 / 运行时作用域
                                         ↓
                                  App 功能动作 action
                                         ↑
                       feature ID ← 用户触发方式 trigger
```

必须区分以下对象，不能都塞进一个“快捷键 → JS 字符串”表：

| 对象                    | 决定什么                                             | 谁维护                          |
| ----------------------- | ---------------------------------------------------- | ------------------------------- |
| application             | 哪个应用；bundle ID；建议路径                        | recipe 作者；用户选实际路径     |
| profile                 | 哪个确切构建；涉及资源的身份                         | code-agent 分析后产出           |
| resource                | 相对于所选 `.app` 的资源路径及原始摘要               | profile                         |
| mount                   | 在资源什么位置插入；在哪个函数作用域；如何挂载与清理 | profile + 已实现 driver         |
| bindings                | 原应用变量与稳定语义名之间的映射                     | profile                         |
| action                  | 调用哪个功能；成立条件；在哪个 mount 执行            | profile 实现稳定 action ID      |
| feature                 | 用户看到的功能名及默认触发方式                       | recipe                          |
| trigger override        | 按键、序列间隔、启用状态、范围                       | 用户设置，单独保存              |
| evidence / verification | 如何找到入口；静态或运行验证做到哪一步               | code-agent 和实际测试者分别记录 |

用户设置引用 `recipeId + featureId`，不保存 `Ce`、`le` 这样的构建私有变量。升级时替换 profile 映射，尽可能保留用户设置；动作消失或语义变化时明确报告不兼容，不自动把旧设置套到其他功能。

## 配置文件与 app bridge

### 可以仅靠声明式配置的情况

已有 driver 能访问需要的作用域，动作只是调用一个已有回调，例如 CodeBuddy 停止按钮：

```json
{
  "action": "chat.stop",
  "mount": "chat-input",
  "invoke": { "kind": "call-binding", "binding": "cancel" },
  "guard": { "binding": "streaming", "equals": true }
}
```

profile 把 `cancel → Ce`、`streaming → le` 映射到已分析构建。trigger 可以独立配置为双 Esc、组合键或禁用，动作本身不用重写。

### 需要 app bridge 的情况

有些动作需要私有服务、参数转换或多个调用。不要无限扩充“JSON 表达式语言”，也不要让每个应用重写键盘监听。

code-agent 可提供一个固定协议的 `bridge.js`，导出 `bind(context)`，返回具名动作方法。构建器解析和打包该文件，嵌入已验证的目标作用域；**不在 Raycast 或 CLI 的 Node 进程里执行 bridge**。

示例中的新建对话动作使用 `bridge-method: newChat`。bridge 从注入上下文取得原应用的模块加载函数，在按键触发时才获取服务并执行；不会在导入或预检查时调用原应用方法。

参考完整示例：

- [recipe](examples/codebuddy-chat.recipe.json)
- [bridge](examples/codebuddy-chat.bridge.js)
- [JSON Schema](hook-recipe.schema.json)

这些是设计示例，不是当前 CLI 的 `--config` 格式。当前 `--config` 仍使用仓库根目录的 `settings.example.json`。

## 安装位置需要分成三个层次

### 资源位置

例如 `Contents/Resources/.../main.chunk.js`，相对于用户选择的应用包。recipe 不应直接声明要覆盖 `/Applications/Whatever`、用户主目录或其他应用。

安装计划要解析实际路径，确认资源属于已选目标；相对路径不能越出应用包。建议安装路径仅用于 UI 默认值，不决定身份。还需核对 bundle ID、构建声明和资源摘要。

首个通用安装器只支持单个 UTF-8 资源文件，称为 `text-resource/v1`，复用现有备份和原子替换流程。ASAR 重打包、原生二进制修改或运行时注入需要各自的安装器，不能把它们伪装成普通文本插入。

### 插入位置

CodeBuddy 示例采用：

- 完整原始资源摘要匹配。
- 指定函数作用域 `ChatInput`。
- 指定精确锚点，在其前插入，匹配次数必须为 1。
- 检查插入点在指定函数中，bindings 在该作用域内可解析。

后两项涉及通用 recipe 编译器的 AST 校验，**尚未实现**；当前内置 CodeBuddy adapter 通过已验证的完整原文摘要和唯一锚点约束已分析位置。

只有锚点匹配或语法通过，不足以证明 `Ce` 仍然是停止回调。新 profile 的业务语义仍依赖分析证据和实际验收。

### 运行时挂载位置

`react-component/v1` driver 负责：

- 使用映射得到的 React、DOM ref、容器解析函数。
- 为当前 mount 注册一次事件路由。
- 在重渲染时保留序列状态、更新回调引用。
- 在卸载时移除监听，失焦时重置序列。

普通页面、preload、扩展宿主等上下文可有其他 driver。安装器回答“怎么把代码写进去”，driver 回答“写进去后在哪运行、如何清理”，两者独立组合，不能默认每个 JS 文件都有 React 或 DOM。

## 事件不是安装位置

首版事件协议只承诺键盘序列：

```json
{
  "kind": "key-sequence",
  "steps": [
    { "code": "Escape", "modifiers": [] },
    { "code": "Escape", "modifiers": [] }
  ],
  "withinMs": 500,
  "scope": "panel",
  "phase": "bubble",
  "consume": "on-match",
  "repeat": "ignore"
}
```

同一 action 可以更换 trigger；同一 mount 的多个 feature 共享一个 driver。系统全局快捷键、菜单项、DOM 事件等可以以后增加独立事件提供器，不能沿用键盘 schema 却隐含扩大权限和作用范围。

需要明确：

- 每一步的物理按键及精确修饰键。
- 单键与序列的区别、超时和长按处理。
- 面板或输入区范围。
- 事件在哪个阶段处理、何时消费。
- 功能 guard 不满足或状态未知时，停止触发并给出原因。
- 同一作用域下的相同快捷键、前缀序列冲突必须可见，不能靠配置排列顺序决定谁获胜。

## 动作参数与运行时协议

`call-binding` 的首版含义应固定为“读取当前 binding 并无参调用”。需要参数的命令、request ID 或对象结构转换交给 bridge，不能猜测给每个回调传入一个 DOM Event。

通用 driver 负责提供明确上下文：

- 稳定的环境能力，例如示例的 App 内模块加载函数。
- `getBinding(name)` 一类读取最新值的接口，用于每次调用时获得最新回调和状态，避免 React 重渲染后的旧闭包。
- 本次调用的规范化事件和该 feature 的用户选项。可复用现有 `SettingField` 字段契约生成自定义参数 UI；这部分 recipe 字段需随编译器实现再定稿，不在附带 schema 中假装已经支持。

bridge 负责把用户选项转成原 App 所需的参数形状。driver 负责事件消费、guard、重复触发管理和卸载清理，不把这些职责交给每个 bridge 重复实现。

回调正常返回只能报告“已调用”；除非 bridge 明确观察到完成条件，不能自动声称业务动作成功。类型不匹配、环境未就绪或状态未知时应返回诊断而不调用。卸载时移除监听器，不擅自取消已经发给原 App 的业务任务。

## code-agent 的交付物

给 code-agent 的任务应是“分析目标并输出 recipe 包”，交付：

1. recipe JSON：稳定功能 ID、精确 profile、资源位置、mount、bindings、动作及默认事件。
2. 可选 bridge：必要的 app 专属语义，不含安装和通用监听代码。
3. 分析记录：按钮在哪里、事件怎么流转、为什么该 binding 对应该功能，区分观察、推导和未知。
4. 验证记录：哪些只做了静态检查；哪些真实操作过；预期成功现象和恢复方式。

不要让 agent 只输出一个 `onClick` 名称或一段没有构建身份的插入代码。原 App 的打包资源不必进入 recipe 包，可保留摘要和足够小的来源片段。

分析记录里的“已验证”不是程序能够自动相信的证明；UI 要显示其来源和实际执行的检查。没有真实运行过，应保留为未运行验证。

## 导入到应用的流程

```text
导入 recipe 包
  → Schema 校验：字段、版本、枚举
  → 语义校验：ID 唯一、引用可解析、策略已实现、事件冲突
  → 选择目标应用，匹配构建与资源摘要
  → 静态编译：作用域绑定、bridge、统一 runtime
  → 内存中生成完整候选资源，检查语法和可还原关系
  → 展示具体计划：资源、功能、触发方式、差异、备份、验证限制
  → 用户在已有“应用”入口执行安装
  → 安装前重新检查；备份、写入、核对结果
  → 用户完成实际功能验收
```

导入和预检查不执行 bridge、不修改应用，不自动启动模型会话或点击按钮。用户的应用操作针对完整、可审阅的具体计划，而不是对“某个 JSON”一概授权。

recipe 如果带 bridge，就是会在目标应用内运行的代码包。JSON Schema 通过只表示结构合法，不代表代码可信或行为正确。宿主只接受已实现的安装器与 driver，不把任意 shell 命令、提权、下载代码或关闭系统保护当成配置字段。

## 多功能与恢复

- 同一资源上的所有启用 feature 先合成为一个计划，再生成一次候选文件。
- 同一 mount 共享路由和清理逻辑，避免每新增一个功能就增加一套全局监听。
- 计划绑定原始构建、recipe 内容摘要、bridge 摘要及用户设置，任何一项变化都重新预检查。
- 已安装元数据记录 recipe/profile 身份和实际启用的功能；不能只写一个“patched”标记。
- 变更功能时从经过验证的原文重新生成，不能在已有补丁上继续叠加。
- 恢复只覆盖仍能证明属于本安装计划的资源，保留原始备份和用户设置。

首版限制为单资源。跨文件写入不能声称天然原子；若后续确需支持，须单独设计部分成功的恢复流程。暂不为尚未存在的多文件需求引入事务框架。

## Schema 能检查与不能检查的内容

随附 Schema 使用 JSON Schema draft 2020-12，限定为设计示例状态。它能检查字段形状、枚举、摘要格式和基础路径格式，不能证明以下事项：

- 路径解析后仍位于用户选择的应用包内。
- profile、mount、action、bridge 方法之间的所有引用及业务含义正确。
- 变量在真实源码中的作用域与类型。
- 两个 trigger 是否冲突。
- bridge 内容与摘要相符、行为正确。

这些由未来的语义验证器、编译器和运行验收承担。遇到不支持的策略、构建或未解析 binding 应明确拒绝，不能降级为字符串拼接后强行安装。

## 与当前实现的关系

| 能力                                      | 当前状态                       |
| ----------------------------------------- | ------------------------------ |
| 内置 app adapter、按应用配置和备份        | 已实现                         |
| CodeBuddy 版本/摘要匹配、双 Esc hook      | 已实现；最初临时补丁有用户实测 |
| 只读预检查、完整 JS 语法解析、安装时重查  | 已实现                         |
| 用户 recipe 导入、Schema 驱动生成 adapter | 设计阶段                       |
| AST 作用域与 bindings 的通用检查          | 设计阶段                       |
| 通用 bridge 打包与 runtime driver         | 设计阶段                       |
| 全局事件、ASAR、多资源或原生注入          | 未实现，需独立策略             |

落地顺序建议：先把当前 CodeBuddy adapter 迁移成这套 recipe 的参照实现，保证行为和恢复不回退；再提供导入、计划预览和动态 UI。此后能由已有策略表达的新功能才做到“agent 分析后提供配置即可安装”，不能表示任意新 App 已天然兼容。
