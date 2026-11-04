# App Hook Studio MCP

独立本地 stdio 服务，与 Raycast 共用 `~/Library/Application Support/App Hook Studio/`。没有 HTTP 端口，也无需 Raycast 常驻。MCP 只提供查询、注册和只读预检查；修改目标 App 的 Install / Restore 留在 Raycast。注册产生可安装适配器，与 UI 的待分析草稿是两个明确的状态。

## 连接

先在项目目录执行 `npm run build:mcp`。将以下内容合并到 code-agent 客户端的 MCP 配置（具体配置文件位置由客户端决定）：

```json
{
  "mcpServers": {
    "app-hook-studio": {
      "command": "/Users/havoc/.nvm/versions/node/v24.20.0/bin/node",
      "args": ["/Users/havoc/Documents/Projects/tools/macOS/app-hook-studio/dist/mcp.cjs"]
    }
  }
}
```

可直接参考项目根目录的 [MCP 配置示例](../mcp.config.example.json)。不同机器需要修改 Node 和项目绝对路径。服务要求 Node >=22.22.2。不要用 `npm run mcp` 作为客户端启动命令，npm 的日志可能污染 stdio 协议；开发时可直接运行 `node_modules/.bin/tsx scripts/mcp.ts`。测试隔离目录使用 `--data-root /absolute/path`，不应在正常连接中改变目录，否则 Raycast 看不到注册结果。

实现使用官方 MCP TypeScript SDK 的 [stdio transport](https://ts.sdk.modelcontextprotocol.io/server#stdio)。源码在 `src/mcp/server.ts`，构建入口在 `scripts/mcp.ts`。

## CodeBuddy 内置批准通知

`list_apps` 和 `get_app {"appId":"codebuddy-cn"}` 已包含 `approval-notification`（工具批准通知），与 Raycast 使用同一内置适配器，无需再调用 `register_items`。该工具不能向内置 App 添加 Recipe。重新构建 MCP 并重启客户端连接后即可发现新功能；Raycast 重新构建安装后，在 CodeBuddy CN 下显示此项。

`preflight_app {"appId":"codebuddy-cn"}` 会把该项纳入整体安装计划，与聚焦桥共用同一扩展资源、备份和恢复路径。MCP 不写入目标 App；在 Raycast 整体 Install 后重启 CodeBuddy。通知使用 CodeBuddy 原有 `Notification` hooks，matcher 为 `permission_prompt`，详见[点位说明](codebuddy-approval-investigation.md)。

## agent 的工作顺序

1. `get_recipe_schema {}` 获取当前可执行协议和 driver 约束。静态文件：[Recipe v2 Schema](recipes/recipe-v2.schema.json)。
2. `list_apps {}` 确认是否已经注册；`get_app {"appId":"example-app"}` 获取完整 Recipe、当前 revision 和保存设置。
3. 在本地生成 Recipe JSON。`validate_recipe {"recipePath":"/absolute/path/recipe.json"}` 只读检查 schema、版本断言、原文 SHA-256、唯一锚点、完整候选脚本语法和备份状态。返回检查项，不回传完整目标资源。
4. `register_app {"recipePath":"/absolute/path/recipe.json"}` 注册新 App。更新已有 ID 必须传入从 `get_app` 取得的 `expectedRevision`；没有隐式覆盖。
5. 向已注册的 App 追加功能时，用 `register_items {"appId":"example-app","itemsPath":"/absolute/path/items.json","expectedRevision":"<current revision>"}`。文件是 feature 对象数组，不会覆盖已有 feature。重复 ID 和快捷键碰撞会拒绝。
6. `preflight_app {"appId":"example-app"}` 按**全部已保存配置**生成整体安装计划。计划包含每份包内原文备份路径以及是否需要退出 App；它不会实际检查运行状态或声称已取得写权限，这两项在执行 Install 时检查。
7. Raycast → Manage App Hooks → ⌘K → **刷新注册应用**（或重新打开入口），在“MCP 注册应用”中配置各项 enabled/快捷键，再 **⌘Enter** 整体安装。安装前退出目标 App，安装后重新打开并验收。

返回 `runtimeStatus` 是 Recipe 作者提供的声明，不是 MCP 独立验证的结果。任何静态检查通过都不等于已经真实运行成功。`get_app` 包含动作源代码，查询前应考虑所需上下文；日常发现使用更小的 `list_apps`。

## 第一版支持范围

- **可执行协议是 `schemaVersion: 2`**，不是旧的 `docs/design/` v1 设计示例。
- 每个 App 一个构建 profile、一个 UTF-8 JavaScript classic-script 资源和一个唯一文本锚点；锚点必须位于允许插入完整语句的位置。
- driver 是 **`dom-keyboard/v1`**。动作是 async 函数体，只在目标 renderer 收到匹配的键盘事件时调用，参数为 `event`、`root`。推荐只通过稳定 DOM/公开命令实现动作，例如 `root.querySelector('[data-action="stop"]')?.click()`。
- 根作用域由 `rootSelector` 指定；仅处理可见 root 内的事件。`shortcut` 使用 `cmd+alt+s` 形式，按物理 code 精确匹配修饰键；普通组合键必须含 Cmd/Ctrl/Option。也支持 `double-escape` 和间隔。忽略按住重复、IME 输入；焦点改变或页面隐藏会重置序列；同一动作执行期间不重复调用。
- 同一 renderer 不重复挂载监听；作用域 DOM 每次事件重新查找。卸载通过退出/重新打开 App 完成，恢复磁盘资源不会移除已经运行在旧页面中的代码。
- 动作语法与完整候选资源只做解析，MCP/Raycast **不求值、不 import、不执行** Recipe 动作。注册本身不会修改 App。动作源码在真正安装并重开 App 后拥有目标 renderer 的能力，用户应审阅 agent 提供的动作与证据。
- 不支持 ASAR 写回、ESM、原生二进制、多个资源或多个 mount，也不支持通用 React hook/private callback driver。现有 **CodeBuddy 内置适配器继续独立工作**；不能用 DOM Recipe 覆盖或追加它的私有回调功能。此类接入需要相应 driver，而不是假装一个 DOM selector 可以替代分析。

完整 [Recipe 示例](recipes/example.recipe.json) 配套 [合成资源原文](recipes/example-main.js)，仅展示协议，不代表真实 App 已完成分析。

版本断言从包内 JSON 文件的 JSON Pointer 读取，第一条对应 App 主版本且必须与 `appVersion` 一致；后续可检查扩展/组件版本。所有相对路径禁止 `..`；资源和断言的真实文件路径必须留在所选包内，防止符号链接把目标指向包外。即使版本相同，也必须匹配原始摘要和唯一锚点。

## 更新、备份与用户设置

Recipe 存在 `recipes/<app-id>.json`，原记录更新前保存为带摘要的 `.bak`，并通过原子替换写入；`expectedRevision` 防止旧分析结果覆盖新注册。注册写入有目录锁，多个 MCP 实例同时注册时会返回 busy。若进程异常终止，确认没有注册进程后可移除 `recipes/.registration.lock` 再重试。解析异常的注册文件保留原文，在 list/界面中显示错误。

用户 enabled/shortcut 继续单独存在 `apps/<app-id>/settings.json`；更新不会覆盖它。沿用 feature ID 可以保留设置，新 feature 使用 Recipe 默认值。删除或改名 feature 不会自动把原设置映射到新语义。

已经安装的动作/触发方式/mount 发生变化时，新的 Recipe 会拒绝接管旧补丁：先使用旧注册条目在 Raycast 中恢复资源，再注册更新，最后整体 Install。若 App 已经自动更新而资源身份不明，应先恢复官方原文件并重新分析。注册失败不会替换旧 Recipe，也不会修改目标 App。

## 验证范围

测试通过真实 MCP stdio 客户端覆盖工具发现、JSON Schema、Recipe 校验、App 注册、Item 追加、revision 冲突和整体预检查；合成 `.app` fixture 验证整体安装、幂等与精确恢复。VM DOM fixture 验证键盘触发、禁用、作用域与重复挂载。它们不是任意真实第三方 App 的运行验收，也不等于 Raycast 原生 UI 已手动测试。
