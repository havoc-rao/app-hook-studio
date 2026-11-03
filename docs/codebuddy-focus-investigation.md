# ⌘I 输入框聚焦修复

## 观察与静态结论

用户反馈原 ⌘I 聚焦失败。用户配置中的工具拥有规则实际调用 `coding-copilot.webviews.chat.focus`，没有 `when` 条件；因此仅移除局部快捷键条件不足以修复。

当前构建 `CodeBuddy 1.106.1 / genie 3.10.0` 的打包代码显示：

- Webview `CBChatWrapper` 的 `window.focus` 恢复逻辑先检查 `si.current`（聊天区此前是否有焦点），否则直接返回；还有首次 session 初始化跳过 focusInput 的分支。视图聚焦与光标进入输入框是不同动作。
- `ChatInput` 的 imperative API `focus()` 通过 `Ue.current.focus()` 进入现有 Slate 编辑器聚焦逻辑；它不发送消息或创建对话。
- 扩展主文件的 `activate(ir)` 等待 `doActivate(ir,rn)` 后已有可用 DI container；可在这一作用域注册独立命令，并由 `ir.subscriptions` 管理清理。
- provider token 来自 webpack 模块 `328150`，VS Code API 来自 `426850`，ChatViewService token 来自 `637830`（旧实现错误使用 `536827`，见下方修正）。provider 的 `webview` 是实际 VS Code Webview，可调用 `postMessage` 并订阅 `onDidReceiveMessage`。
- `ChatViewService.activatePage({path:"/"})` 不带 `newConversation`；路由实现对相同路径直接返回，新对话分支明确检查 `params.newConversation`。此处不请求新建对话。
- Workbench 的终端默认 `_Yt` 跳过 shell 的命令名单含 `runCommands`，不含新增命令；终端检查还要求 `sendKeybindingsToShell` 为 false。`runCommands` 的实际参数 schema 支持字符串命令数组。

这是包内代码建立的静态调用关系，**不等于已在真实 UI 中验收修复**。电脑控制权限此前不可用，本次未绕过它注入运行探针。

## 修复链路

```text
用户无 when 条件的快捷键（默认 cmd+i）
 → runCommands {commands:["app-hook-studio.codebuddy.focusInput"]}
 → 原生聊天视图 focus
 → 等待已有 Webview/RPC 就绪，返回当前聊天路径 /
 → 专用 focus-input 消息（带 requestId）
 → ChatInput 收到请求，调用原有 Ue.current.focus()
 → 检查 activeElement 位于当前输入区且是可编辑元素
 → Webview 返回同 requestId 的 focused:true 确认
```

不注册通用 `window.focus` 抢焦点监听；普通点击菜单或按钮不会触发注入的 focus 请求。初始化尚未挂载接收器时仅在这次请求的 2 秒内每 100ms 重试，确认后立即移除监听/定时器。超时和消息发送失败显示错误。命令执行中重复调用共享同一请求；扩展停用会取消自己的待确认请求。输入框卸载会移除监听并取消自己的确认定时器。

如果用户或 workspace 显式启用 `terminal.integrated.sendKeybindingsToShell`，它仍然可以覆盖终端分发；本修复不会擅自改这项用户偏好。

## 安装、迁移与恢复

App 整体计划现在校验并备份两份资源：原聊天 Webview，以及扩展主文件。所有资源与快捷键记录在首次写入前重新检查；资源有变化须退出 App。各文件分别原子替换，不声称跨文件事务。后一步失败显示阶段结果，允许重试。

原 v1 Webview renderer 保留在 `hook-v1.ts`，只用于精确识别已有安装并升级为带焦点接收器的 v2；不猜测接管未知字节。JSONC 所有权不变，显式允许从旧 `.focus` 命令迁移到 `runCommands` 包装命令；保留用户保存的快捷键、enabled 和其他规则。JSONC 的参数对象在安装器边界归一化，避免解析器的空原型对象与普通配置对象比较失真。

聚焦命令桥接的备份位于应用数据目录 `focus-keybinding/bridge/backups/`。恢复整个资源补丁会恢复两份资源；用户规则和偏好保留，新的专用命令须重新整体安装才能使用。关闭某项只停用它的快捷键触发；App 中惯常按钮与其他功能不受影响。

## 证据与验证范围

- REA CLI 6.8.0 对所选 `package.json` 做静态清单分析，完整 Evidence：`ev_e409cdf4c5e42e553bf55cedc9e03e39e69415114b00a4411f9d1c4bb984696d`；导出 `/private/tmp/app-hook-studio-focus-manifest-20261103.json`。该 Evidence 不覆盖未选中的 JS 调用链。
- 上述 handler、DI token、终端分发与输入框 API 来自额外直接读取对应打包文件。Webview 原文 SHA-256：`ee829469ee2b4edd4c04f09f8b828840f196c82e22f5973d909ce6f29445c31f`；扩展主文件 SHA-256：`f99b6e1e25e62b442bc7335b67e859f80c3b6d6a1c51d31cfb52591c578aa42e`。主文件注入锚点为唯一的 `}async function doActivate(ir,ar){`，位于 activate 函数末尾、doActivate 声明之前。
- 回归测试模拟显式请求/焦点确认、请求合并、超时、发送失败、扩展停用、晚就绪、输入组件卸载和旧规则迁移。真实包只做完整候选语法解析和字节恢复校验，不执行原包。
- 真实 UI 中编辑器、终端、已存在草稿、历史/设置页切回等场景仍需重启后验收。预检查通过不会把它们标记为已完成运行验证。

## Raycast 堆限制

扩展主文件的读取、生成、检查和写回现由独立资源进程执行，避免 21 MB 资源的多个字符串副本占满 Raycast 的 100 MB 命令堆。完整说明见 [内存修复记录](raycast-memory.md)。

## 修正服务映射：v1 → v2

真实日志 `logs/20261103T215538/window1/exthost/exthost1-codebuddy.log` 在 2026-11-03 23:03:21 / 23:03:31 记录 `RPCImpl.getProxy` → `Cannot read properties of undefined (reading 'toString')`。旧注入错误从模块 `536827` 取 `ChatViewService`；该模块只 re-export 其他模块且没有此导出。真正定义 `ChatViewService = Symbol("ChatViewService")` 的模块为 `637830`，现有聊天命令经 `5239` 重导出同一 token。

根因是映射选择错误，而原来的模拟 require 恰好把错误编号也映射成了成功的服务，静态语法检查无法发现它。修复将编号集中到 `focus-bindings.ts`，在资源预检查中用 Acorn 仅解析选定模块的 AST，确认实际导出 Symbol 定义；不建立整包 AST，也不执行原包。运行时再验证 Symbol，错误标明阶段。外层 runCommands 本身会显示失败，命令不再额外重复显示同一错误。

旧 host renderer 保留在 `focus-host-runtime-v1.ts`，只用于完整识别已安装的旧块并迁移到 host v2；备份原文摘要及用户快捷键不变。回归明确断言原错误模块缺少导出、正确模块具有导出，并覆盖缺失 token 的运行防护与旧版本升级。此修复仍需整体 Install 并重启后的真实 UI 验收。
