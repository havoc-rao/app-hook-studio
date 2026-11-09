# CodeBuddy Hotkeys Quickstart 工作指南

本目录是可独立运行的 Python 工具，详细说明见 [README.md](README.md)。优先使用现有安装器，不临时绕过摘要检查写 App。Python 需 3.9+；本机脚本仅需标准库，远程安装还需要本机 SSH 和服务端自带 Node 做语法检查。

## 基本使用

在本目录运行本机工具：

```sh
python3 hotkeys.py preflight
python3 hotkeys.py apply
python3 hotkeys.py status
python3 hotkeys.py restore
```

- 默认 App 为 `/Applications/CodeBuddy CN.app`；可用 `--app`、`--keybindings`、`--data-dir` 指定目标。恢复时使用相同目标和备份目录。
- 修改 App JS 前须保存工作、⌘Q 完全退出；任何已安装配置的更新都必须先 restore，再 apply；apply 拒绝尚未恢复的 backup/安装记录和残留补丁。App JS 改动需重开生效。
- 默认：`ctrl+cmd+n` 全局新建、`cmd+i` 聚焦、聊天区域内 500ms 双 Esc 停止。用 `--new-chat`、`--focus`、`--stop` 改键，`off` 关闭对应能力。
- 配置的 `new_chat_enabled`、`stop_enabled`、`focus_enabled` 为独立布尔开关，默认全开；关闭保留按键配置。远程和本机需分别应用配置。旧 `off` 写法仍兼容。
- 新建通过无 `when` 的 IDE `runCommands` 调用原生命令；停止仍是聊天范围内的 Webview 监听，不是全局快捷键。

远程工具在本机发起，SSH 目标、端口、解释器均可切换：

```sh
python3 remote_hotkeys.py preflight --host user@example.com --port 36000
python3 remote_hotkeys.py apply --host user@example.com --port 36000
python3 remote_hotkeys.py status --host user@example.com --port 36000
python3 remote_hotkeys.py restore --host user@example.com --port 36000
# 系统 python3 太旧时，以上命令追加：
# --python /absolute/path/to/python3
```

- SSH 使用 `BatchMode=yes`，需已有可用认证；不安装 Python，不修改默认解释器。
- 远程资源在登录用户的 `~/.codebuddy-server-cn/bin/stable-<commit>/`。远程脚本不管理本机快捷键；本机仍需安装对应绑定。
- 远程 `--config` 接受与本机相同的 `config.example.json` 格式，也兼容旧运行设置（`newChatEnabled`、`stopMode` 等）。自定义远程设置时后续检查、重装也传同一配置。
- 安装/恢复只写磁盘，不结束现有会话。之后重新连接远程窗口；仍加载旧命令时重启远程扩展宿主或重新加载窗口。

## 备份与恢复

- 本机默认备份：App 内 `Contents/Resources/codebuddy-hotkeys-quickstart-backup/`。
- 远程备份：对应 `stable-<commit>/app-hook-studio-remote-backup/`。
- 首次现场存为 `*.before`，`state.json` 记录路径、原始摘要、可接受摘要和阶段；恢复后重新安装保留首次基线；restored 备份可复用，但当前文件必须匹配备份且 JS 为已验证原文。
- 本机 `restore` 整文件恢复快捷键，后加的用户改动会触发拒绝覆盖。先比对、保留用户修改，再做有针对性的恢复；不要删状态、改摘要来强行通过。
- 各目标分别原子替换，不是跨文件事务。失败保留现场与备份，核对已完成项，先 restore 再 apply。
- App/服务端更新可能清除包内备份；更新前恢复或另存备份。恢复后保留备份目录。

## 遇到版本、摘要或远程差异

当前本机支持 CodeBuddy 1.106.1 / genie 3.10.0；远程只支持 `remote_hotkeys.py` 中 `COMMIT` 对应的已验证构建。`HOST_SHA256` 是远程原始宿主文件摘要，不是机器标识。

1. 先只读检查：App/扩展版本、服务端 `product.json` commit、两份 JS 的 SHA-256、当前安装状态。
2. 远程可并存多个 `stable-*`；通过实际 `server-main.js`、`bootstrap-fork --type=extensionHost` 进程路径及最新日志确定当前构建。目录存在不代表正在运行；没有进程也不代表未安装。
3. 相同版本号不保证相同字节。本次本机与远程 Webview 原文一致，但宿主摘要不同；必须单独验证，不能直接复制本机宿主文件。
4. 未知构建先提取原文分析并增加明确的 profile/版本支持。不要仅修改 `COMMIT`、`HOST_SHA256`，也不要跳过校验来接管未知代码。
5. 新模板同步更新 `runtime/manifest.json` 的模板摘要和参考向量，保留旧 renderer 供精确识别与迁移。修改后重建同级 ZIP，排除 `__pycache__` 和测试文件。

## App 分析经验与排查顺序

- 从 `package.json` 的菜单/command 声明追到实际 handler，再追服务、RPC 和 Webview；不要靠按钮外观猜入口。清单分析结果不等于完整 JS 调用链证据。
- 先区分 IDE 快捷键、扩展宿主命令和 Webview 事件。输入框内有效、编辑器内无效通常是监听范围问题；需要全局能力时优先绑定已有 IDE 命令。终端另检查 `terminal.integrated.sendKeybindingsToShell`。
- `command ... not found` 表示当前命令注册表无该命令，先查扩展宿主位置、激活和是否加载补丁；不是输入框 focus 失败。本地安装不覆盖远程宿主和它提供的 Webview。
- 聚焦桥接在 `activate()` 等待 `doActivate()` 后注册，复用初始化好的 DI container；注册与消息监听纳入 subscriptions/清理生命周期。先激活视图、等待 RPC，再发聚焦请求，用 requestId 和实际焦点确认回执验证。
- 本次已核对的宿主模块：`426850` 为 VS Code API、`328150` 导出 provider token、`637830` 导出 `ChatViewService`。旧错误编号 `536827` 没有这个导出；新构建必须重新确认真实导出，不能让 mock 随意把编号映射成成功对象。
- 必须检查注入点的词法作用域：本次 `ChatInput` 的局部 `var r` 遮蔽了外层 Webpack require。v3 在模块作用域保存 `cbHotkeysRequire`；语法正确不代表变量绑定正确。
- 停止复用组件现有 `onCancelSend` 回调及生成状态，通过 ref 保持最新值。不要自行猜测取消请求；检查 IME、长按、焦点范围、事件是否已消费和监听清理。
- 用户反馈偶尔成功时，不把一次成功当作修复完成。分别验证输入框、代码编辑器、终端、本地/远程窗口及重复调用；查按键是否到达、命令是否执行、RPC 是否就绪。

## 验证与交付

在仓库根目录运行：

```sh
python3 -m unittest discover -s quickstart/tests/codebuddy-hotkeys-quickstart -v
```

真实原文集成测试需通过 `CODEBUDDY_TEST_ORIGINAL`、`CODEBUDDY_TEST_HOST` 和 `CODEBUDDY_TEST_REMOTE_HOST` 指向可信原文/备份；未提供会跳过相应测试。覆盖重复安装、改键、精确恢复、备份损坏、外部修改和真实作用域回归。完整候选 JS 用 Node 检查语法，勿执行整个未知 App 包。

明确区分“预检查通过”“磁盘安装通过”“重启后的 UI 验收通过”。安装器不自动做真实会话验收；不要把静态摘要、语法或模拟测试当作 UI 证据。Python 快照与 Raycast TS 实现可能不同步，修复其中一方不代表另一方已修复；仓库调查记录见 `../../docs/codebuddy-investigation.md` 和 `../../docs/codebuddy-focus-investigation.md`。
