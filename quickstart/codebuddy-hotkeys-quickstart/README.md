# CodeBuddy Hotkeys Quickstart

独立的 Python 快速体验包，提供新建对话、停止聊天、聚焦输入框三个能力。**只需 Python 3.9+ 标准库**：无需 Raycast、Node、npm、pip 或 App Hook Studio 工程；整个目录可以复制到其他位置独立运行。

当前支持 **CodeBuddy CN 1.106.1 / 内置 genie 3.10.0**，同时核对资源原文 SHA-256 和唯一插入位置。其他版本拒绝安装，不按相似文件名猜测。

## 最快使用

下面使用默认快捷键。若要改键，请看后面的「用配置文件自定义快捷键」。

进入解压后的目录：

```sh
python3 hotkeys.py preflight
# 保存工作，⌘Q 完全退出 CodeBuddy
python3 hotkeys.py apply
```

重新打开 CodeBuddy 后使用：

| 功能 | 默认快捷键 | 范围 |
| --- | --- | --- |
| 新建对话 | Ctrl+⌘+N | 聊天面板 |
| 停止生成 | 500ms 内 Esc → Esc | 聊天面板，生成中 |
| 聚焦输入框 | ⌘I | CodeBuddy 窗口内，包括编辑器、默认设置下的终端 |

按住 Esc 不算两次；第一次不拦截。聚焦调用原输入框 API，并等待焦点确认，不会新建对话或清空草稿。若显式配置了 `terminal.integrated.sendKeybindingsToShell: true`，终端仍可能把快捷键交给 shell；脚本不会擅自修改该偏好。

`preflight` / `status` 只读，可以在 App 运行时执行。`apply` / `restore` 要求 App 完全退出，包括写入或更新包内备份记录时。输出为 JSON，便于终端或 code-agent 查看。

## 用配置文件自定义快捷键（推荐）

**`config.example.json` 就是快捷键配置示例。脚本不会自动读取它，必须通过 `--config` 显式指定。** 建议先复制为 `config.json` 再编辑；也可以直接编辑示例文件，并使用 `--config config.example.json`。

```sh
cp config.example.json config.json
```

用编辑器打开 `config.json`，按需要修改：

```json
{
  "app": "/Applications/CodeBuddy CN.app",
  "new_chat": "ctrl+cmd+n",
  "stop": "esc,esc",
  "focus": "cmd+i",
  "double_escape_ms": 500,
  "scope": "panel"
}
```

| 字段 | 含义 | 可选值或示例 |
| --- | --- | --- |
| `app` | 要安装补丁的 App 路径 | `/Applications/CodeBuddy CN.app` |
| `new_chat` | 新建对话快捷键 | `ctrl+cmd+n`；`off` 关闭 |
| `stop` | 停止聊天快捷键 | `esc,esc` 双 Esc；`cmd+alt+.` 组合键；`off` 关闭 |
| `focus` | 聚焦输入框快捷键 | `cmd+i`；`cmd+shift+i`；`off` 关闭 |
| `double_escape_ms` | 双 Esc 两次按键的最大间隔，单位毫秒 | 正整数，默认 `500`；仅双 Esc 模式生效 |
| `scope` | **新建、停止**的生效范围 | `panel`：聊天面板；`input`：仅聊天输入区域 |
| `keybindings`（可选） | 自定义 IDE 用户快捷键文件路径 | `/absolute/path/keybindings.json` |

**`scope` 不影响聚焦功能**，聚焦快捷键仍作用于 CodeBuddy 窗口内。

例如，把聚焦改成 `cmd+shift+i`、停止改成 `cmd+alt+.`，修改对应的 `focus`、`stop` 值即可。JSON 不支持注释，字符串使用双引号。

编辑后，先检查，再退出 App 并应用：

```sh
python3 hotkeys.py preflight --config config.json
# 保存工作，⌘Q 完全退出 CodeBuddy
python3 hotkeys.py apply --config config.json
```

**只修改 JSON 不会生效。必须重新执行 `apply --config config.json`，再重新打开 CodeBuddy。** 首次安装时不传 `--config` 会使用默认配置；安装过以后，不传配置文件会沿用此体验包已保存的设置。

配置优先级：默认值 → 此快速体验包此前保存的设置 → `--config` 文件 → 显式命令行参数。预检查不会保存配置。即使只调整一项，也会按整个 App 统一应用配置。

## 通过命令行参数自定义

也可以不使用 JSON，直接通过参数：

```sh
python3 hotkeys.py preflight \
  --new-chat 'ctrl+cmd+n' \
  --stop 'cmd+alt+.' \
  --focus 'cmd+shift+i'

python3 hotkeys.py apply \
  --new-chat 'ctrl+cmd+n' \
  --stop 'cmd+alt+.' \
  --focus 'cmd+shift+i'
```

双 Esc 使用 `--stop 'esc,esc'`（也接受 `esc+esc`），间隔可配：

```sh
python3 hotkeys.py apply --stop 'esc,esc' --double-escape-ms 650
```

单项关闭用 `off`，仍以整个 App 为单位安装：

```sh
python3 hotkeys.py apply --new-chat off
python3 hotkeys.py apply --stop off
python3 hotkeys.py apply --focus off
```

支持 `cmd / command / meta`、`ctrl / control`、`alt / option / opt`、`shift`，字母、数字、F1–F24、方向键与常用标点。以物理按键 code 匹配修饰键。新建和聚焦至少需要 Cmd/Ctrl/Option；三项触发冲突会拒绝应用。

`--scope panel` 为聊天面板；`--scope input` 将新建、停止限制在聊天输入区域。它不改变聚焦快捷键的 App 窗口范围。

安装后设置会保存。再次只传 `--focus` 会保留此前的新建、停止等配置；每次改配置后重新打开 App。

## 状态与恢复

```sh
python3 hotkeys.py status
# 保存工作，⌘Q 退出后
python3 hotkeys.py restore
```

恢复的是**本次快速体验之前的精确文件**，包括应用资源和快捷键。如果体验前已安装 Raycast 版本，会恢复到那个状态；若体验前没有 keybindings.json，恢复会删除本工具创建的该文件。

默认直接在**目标 App 内部**保存原文件备份和恢复记录：

```text
/Applications/CodeBuddy CN.app/Contents/Resources/codebuddy-hotkeys-quickstart-backup/
├── webview.before       # 体验前的聊天 Webview JS
├── host.before          # 体验前的扩展主文件 JS
├── keybindings.before   # 体验前的用户快捷键文件；原文件不存在时不创建
└── state.json           # 原路径、备份摘要、工具写入过的摘要和配置
```

第一次 `apply` 先备份，再修改原文件。之后反复修改快捷键**不会覆盖首次备份**。`restore` 核对备份 SHA-256 及当前文件身份，再把这些 `.before` 文件覆盖回记录的原路径，并做写后校验。快捷键原先不存在时，恢复会删除本工具创建的文件。

恢复后保留备份目录，便于后续检查或再次体验；恢复的是目标文件内容，并不删除这个额外目录。因此不能把它称为整个 App 目录“完全无痕”恢复。它不覆盖 Raycast / App Hook Studio 的配置与备份。

**App 官方更新可能清除包内备份。** 更新前请先 `restore`，或另存整个备份目录。若需要长期将备份放在包外，可显式传 `--data-dir '/absolute/path/backups'`；后续恢复需传同一目录。

兼容旧版放在 `~/Library/Application Support/CodeBuddy Hotkeys Quickstart/<应用路径摘要>/` 的活动记录：若包内没有记录，会继续使用旧备份，不会丢失最初状态；先 `restore` 后，再次默认 `apply` 就使用新的包内备份设计。

为避免抹掉后续手工修改，如果文件在体验后被其他工具或用户改写，会拒绝继续安装/恢复，保留现场和备份供检查。不要同时用两个工具改同一份 App；可以先恢复快速体验，再继续使用 Raycast。跨文件写入不是原子事务，中途失败会列出已完成项；记录预先保存，可重试或恢复。

## 权限与检查边界

执行 `apply` 会修改指定 App 的两份 JavaScript 资源和用户快捷键文件；不会修改 Raycast 工程。遇到 `Operation not permitted`，在系统设置 → 隐私与安全性 → App 管理中授权**运行 Python 的当前终端**，然后重试。Raycast 的授权不与终端共享，脚本不自动提权或修改系统保护。

运行模板是已验证实现的独立快照，不包含 App 源码，也不依赖原工程。安装前检查模板完整性、App/扩展版本、资源原文摘要、已知补丁精确重建、唯一插入位置和备份；Python 现场不做完整 JavaScript 语法或 AST 分析，模板已在归档生成时验证。未知字节改动会拒绝接管。

主程序：`hotkeys.py`；默认配置：`config.example.json`；必要运行文件：`runtime/`。把这三部分与 README 一起复制即可独立运行。

## 验证说明

开发测试已移出体验包，不参与脚本运行，也不放进 ZIP。快照与原实现的六组配置/版本渲染摘要已逐字核对；开发验证覆盖临时 App 副本的安装、改键、恢复和无 Node 环境的便携运行。

三个能力复用已获用户运行反馈的实现，不代表所有 App 版本和终端设置均已验收。

## 新建聊天修正（Webview v3）

当前构建的 ChatInput 函数声明了局部 `var r`，会遮蔽模块的 Webpack require。
v3 在 ChatInput 外通过带标记的代码块保存 `cbHotkeysRequire`，新建聊天使用该引用。
安装器精确校验两处注入与原文摘要，识别 v1/v2/v3；恢复仍使用首次备份。
此修复适用于独立 Python 快速体验包；Raycast 的 TS renderer 尚未同步。

新建聊天同时注册无 `when` 条件的 IDE `runCommands` 快捷键，调用原生
`tencentcloud.codingcopilot.chat.startNewChat`，由 `// app-hook-studio:new-chat`
标记管理，因此在代码编辑器等区域也能触发。终端沿用 IDE 对 `runCommands`
的分发；显式启用 `terminal.integrated.sendKeybindingsToShell` 时仍可能交给 shell。
仅快捷键配置发生变化时允许在线更新；修改 App JS 资源仍要求完全退出。

## Remote SSH 资源补丁

`remote_hotkeys.py` 从本机通过 SSH 标准输入执行临时 Python 工作代码，不在远端安装辅助程序。
目前只支持服务端 commit `8e9c06cb4efccd833fc8edb84123652746908a7d`、CodeBuddy 1.106.1 / genie 3.10.0。
它单独校验远程宿主原文摘要 `17595b239ec1ac1e54d2a3bc726745fc8d9c24a49fe1361414c3dccdd3acc919`，不放宽本机 profile。

```sh
python3 remote_hotkeys.py preflight --host root@example.com --port 36000
python3 remote_hotkeys.py apply --host root@example.com --port 36000
python3 remote_hotkeys.py status --host root@example.com --port 36000
python3 remote_hotkeys.py restore --host root@example.com --port 36000
```

远程 `extensions/genie/out/extension/index.js` 在 `activate()` 等待 `doActivate()` 后注册聚焦命令，
使用已有 provider 向当前 Webview 发送聚焦请求并等待确认。远程提供的 Webview 文件安装 v3 hook，
提供聚焦接收器和聊天范围内双 Esc 停止。新建聊天和聚焦的 IDE 快捷键仍由本机 `hotkeys.py` 管理。

备份位于远程对应的 `stable-<commit>/app-hook-studio-remote-backup/`，含 `host.before`、
`webview.before` 和 `state.json`；重复安装保留首次备份。外部修改、损坏备份或未知构建会拒绝写入。
两份文件分别原子替换，不保证跨文件事务；中断后可重试或恢复。仅写磁盘资源，安装与恢复后都需重新连接远程窗口
（必要时重新加载窗口或重启远程扩展宿主）；脚本不结束现有会话，也不自动重启服务。
服务端更新到新 commit 后需要重新分析，备份不会自动迁移。

远程默认 `python3` 必须为 3.9+；可用 `--python /absolute/path/to/python3` 指定已有解释器，不修改远程默认 Python。
