# App Hook Studio

正式标识采用 **App Port**（应用轮廓与青色接入点）。Raycast 图标为 `assets/icon.png`，设计原稿与其他方案见 [logo 目录](assets/logo-explorations/README.md)。

为 macOS 应用分析结果提供本地补丁、配置 UI 和恢复管理。以 Raycast 扩展为入口，**每个应用有独立的 adapter**；CodeBuddy CN 是第一个已接入的应用。

当前 UI 层级：

```text
Manage App Hooks
  └─ CodeBuddy CN（使用 .app 自带图标）
      ├─ 新建对话 → 启用状态、快捷键、聊天范围
      ├─ 停止聊天 → 停止方式、双 Esc 间隔或组合键、聊天范围
      └─ 聚焦输入框 → 启用状态、快捷键、应用内全局范围
```

每项功能单独进入配置。应用路径、备份、完整恢复和兼容检查位于功能列表的 **Actions → 应用设置与维护**。

| 已支持应用   | 已验证构建                                        | 可调整行为                                        |
| ------------ | ------------------------------------------------- | ------------------------------------------------- |
| CodeBuddy CN | 1.106.1 / 内置 genie 3.10.0，同时校验资源 SHA-256 | 新建对话、双 Esc 停止聊天、自定义组合键和作用范围 |

目前只有上述真实应用 adapter。共享引擎处理 **UTF-8 资源文件补丁**；新应用必须先独立分析，再实现并验证 adapter。项目不会把 CodeBuddy 的变量名或注入规则套到其他应用，也不承诺通用原生二进制注入。

## 使用

依赖 macOS、Raycast、Node.js ≥ 22.22.2。`.nvmrc` 固定为本机已有的 24.20.0。

```bash
cd /Users/havoc/Documents/Projects/tools/macOS/app-hook-studio
nvm use
npm ci
npm run dev
```

在 Raycast 搜索 **Manage App Hooks**，选择 **CodeBuddy CN**，再选择要配置的功能。

1. 检查应用路径与已安装状态。
2. 在单项配置页调整快捷键和范围。CodeBuddy 默认 **Ctrl+⌘+N 新建对话**、**500ms 内 Esc → Esc 停止聊天**。
3. 先选择 **预检查（不写入）**，查看逐项结果。
4. 静态兼容检查通过后，用 **⌘Q 完全退出目标应用**。
5. 返回 App 层按 **⌘Enter** 进入整体安装确认页，查看权限与重启要求，再次 **⌘Enter** 执行所有功能的安装。

需要安装为本地发布构建时：

```bash
npm run install:local
```

本地安装不同于发布到 Raycast Store。项目没有发布脚本，不上传配置或应用资源。如果之前安装过旧名称 CodeBuddy Hotkeys 的本地扩展，新名称的入口不会自动替代 Raycast 里的旧扩展条目；确认新入口可用后，可在 Raycast 设置中移除旧条目。

## App 整体安装与快捷键

每个功能配置页均可独立设置启用/关闭；功能列表显示已保存的启用状态。保存后需整体安装才会生效，关闭某项会在下次安装时停用该功能，其他功能按各自配置处理。

**安装单位始终是整个 App。** 三个功能页只保存设置，没有单项安装。App 的 Install 会使用全部已保存设置，将新建与停止合并为一份聊天补丁，并处理聚焦快捷键的启用状态。

| 页面           | Enter              | ⌘Enter                                  |
| -------------- | ------------------ | --------------------------------------- |
| App 列表       | 查看该 App 的功能  | 打开该 App 的整体安装确认页             |
| 功能列表       | 配置选中功能       | 打开整个 App 的安装确认页               |
| 功能配置页     | 保存本项配置       | 先保存本项，再打开整个 App 的安装确认页 |
| App 安装确认页 | 不依赖列表默认动作 | 执行整个 App 的安装                     |

动作显式声明快捷键，不依赖 Action 排序，也不会用“进入更多功能”的页面代替 Install。

安装确认页只读展示所有功能的配置、实际修改位置、权限、退出与重启要求和检查结果。再次 ⌘Enter 才写入。正式执行重新检查所有目标，聊天资源有变化时要求先退出 App；不会自动强退或索取管理员权限。

- **App 包权限**：Raycast 需具备“App 管理”授权和目标资源写权限，终端的授权不能代替 Raycast。
- **用户配置权限**：聚焦快捷键另需用户配置文件写权限；专用命令桥接也会修改 `.app`，因此整个 App 的安装仍需要 App 管理权限。
- **重启**：聊天资源有变化时，完成后重新打开 App。仅配置更新通常即时生效；如果先前安装后尚未重开，仍应重开。

整体安装分步写入，不声称跨文件原子提交。只有全部步骤成功才显示“App 安装完成”；中途失败明确列出已完成、失败、未执行的步骤，保留备份供重试或在应用管理中恢复。失败步骤本身也可能部分写入，以其错误详情为准。重试会重新检查，不叠加聊天 hook。

## 配置与维护

UI 根据 adapter 的 feature 描述分组，仅显示所选功能的字段。单项保存保留其他功能设置；所有已保存配置在 App Install 时统一应用。当前 CodeBuddy 配置为：

| 字段        | 默认         | 说明                                      |
| ----------- | ------------ | ----------------------------------------- |
| 新建对话    | 启用         | 可单独关闭                                |
| 新建快捷键  | `ctrl+cmd+n` | 至少使用 Cmd、Ctrl、Option 中的一个修饰键 |
| 停止方式    | 双 Esc       | 可选组合键或禁用                          |
| 双 Esc 间隔 | 500ms        | 正整数毫秒                                |
| 停止组合键  | `cmd+alt+.`  | 仅选择组合键方式时生效                    |
| 生效范围    | 聊天面板     | 可缩小为输入区域                          |

按物理 `KeyboardEvent.code` 匹配组合键。双 Esc 的第一次按键继续交给页面，第二次满足时间与生成状态条件才停止；长按重复事件不算第二次。其他键、焦点变化、窗口失焦和生成结束会重置序列。页面已消费或阻断冒泡的 Esc 可能优先用于菜单或弹层。

它是聊天页面内的事件监听；IDE 编辑器或其他窗口获得焦点时不触发。关闭 Raycast 后仍然有效。

操作入口：

- **预检查（不写入）**：在内存中生成补丁并验证，输出检查结果，不创建备份、不写配置或应用文件。
- **仅保存配置**：保留表单草稿，不修改目标应用。
- **Install / 安装 App**：统一预检查并显示所有已保存功能的安装计划，执行后按步骤报告结果与重启要求。
- **读取已安装配置**：从资源中的补丁元数据填入表单。
- **备份并接管现有补丁**：长期保存原始资源，不改变正在使用的补丁。
- **恢复原始文件**：恢复当前受支持构建的完整原始资源，保留配置和备份。

示例见 [settings.example.json](settings.example.json)。配置有 `appId`，不能把一个应用的配置用于另一个应用。

## ⌘I：CodeBuddy 窗口内聚焦输入框

旧方案只绑定聊天视图 `.focus`，用户反馈无法可靠将光标送入输入框。修复后使用专用命令与 Webview 确认：

```json
{
  "key": "cmd+i",
  "command": "runCommands",
  "args": { "commands": ["app-hook-studio.codebuddy.focusInput"] }
}
```

专用命令先打开聊天视图，再调用该构建输入框原有的 `focus()`，确认可编辑元素获得焦点。默认终端分发名单支持 `runCommands`；如果显式配置了 `terminal.integrated.sendKeybindingsToShell: true`，终端仍可能把快捷键交给 shell。不会自动修改这项偏好。

Raycast → CodeBuddy CN → **聚焦输入框** 保存启用状态与快捷键，然后退出 CodeBuddy，执行 **App 整体 Install** 并重开。本次同时升级聊天 Webview 接收器、扩展命令桥接和用户快捷键规则；旧 v1 补丁及拥有的 `.focus` 规则会被精确识别并迁移。关闭功能会移除工具拥有的触发规则，保留其他用户配置。

不在任意窗口激活时自动抢焦点，也不创建对话或改写草稿。命令等待焦点确认，失败会显示错误。完整分析与运行验证边界见 [聚焦修复记录](docs/codebuddy-focus-investigation.md)；真实 UI 仍需验收。独立安装快捷键的旧 CLI 维护入口已移除，避免只安装规则而遗漏桥接。

## 架构

```text
Raycast 应用列表 → 通用配置表单 ─┐
                              ├─ 共享补丁引擎 → 备份、写入、校验、恢复
CLI：--target <app-id> ────────┘          │
                                       └─ 应用 adapter
                                            ├─ 配置字段与语义校验
                                            ├─ 构建识别与 profile
                                            ├─ 原始资源和已安装补丁的识别
                                            └─ 该应用的 hook 生成与事件入口
```

```text
src/
  apps/
    registry.ts                 已支持应用与稳定 ID 的注册表
    codebuddy-cn/
      adapter.ts                CodeBuddy 的接入点、UI 字段、版本识别
      settings.ts               CodeBuddy 专属设置校验
      profile.ts                已验证资源的摘要与插入锚点
      hook.ts                   React hook、旧补丁识别、原文还原
  core/
    contracts.ts                adapter、profile、设置字段、配置的共同契约
    engine.ts                   跨应用的检查、接管、应用与恢复
    storage.ts                  按应用隔离的设置和备份
    shortcuts.ts                通用按键解析
    hash.ts                     资源摘要
  ui/app-features.tsx           App 内功能列表
  ui/configure-resource-feature.tsx  单项聊天补丁配置
  ui/configure-native-feature.tsx    单项 IDE 快捷键配置
  ui/configure-application.tsx       App 路径与维护操作
  ui/install-app.tsx                 App 整体安装说明、执行与结果页
  application/app-install.ts        App 级只读计划、分步执行与失败报告
  manage-hooks.tsx              Raycast 应用列表入口，使用 .app 文件图标
scripts/cli.ts                  与 Raycast UI 共用同一引擎
```

共享层不读取 CodeBuddy 的 package.json，也不解释其私有模块 ID、按钮函数或 React 状态；这些事实由 CodeBuddy adapter 提供。引擎再次核对 adapter 返回的原文摘要，并检查生成的补丁能否被同一 adapter 解析为预期设置，再允许写入。

### code-agent 生成 recipe 的后续设计

统一映射与导入流程见 [Recipe 协议设计](docs/design/hook-recipes.md)，附带机器可读 Schema、CodeBuddy recipe 与 bridge 示例。它将应用身份、构建 profile、安装位置、运行时作用域、动作和触发事件分离。

**旧 v1 Recipe 仍是设计稿。现已实现 MCP 注册的可执行 Recipe v2**，当前 driver 为 `dom-keyboard/v1`。协议、连接方式和限制见 [MCP 使用说明](docs/mcp.md)；React 私有回调仍按内置 adapter 接入。

### 添加应用

1. 在 `src/apps/<app-id>/` 中保存该应用的分析说明与 adapter。
2. adapter 声明配置字段、默认值、语义校验、构建识别、补丁解析和生成方式。
3. 用明确的构建身份与资源摘要约束支持范围，不仅匹配文件名或版本号。
4. 在 `apps/registry.ts` 注册稳定 ID；通用 UI 和 CLI 会使用同一个 adapter。
5. 增加实际资源边界上的安装、重复应用、配置更新与精确恢复验证，标注未验证部分。

应用由内置 adapter 与本地注册的声明式 Recipe 共同提供；Recipe 动作不在宿主中执行，安装后由目标 renderer 执行。每个资源引擎支持一个 UTF-8 资源的原子替换；App 计划可组合多份资源（CodeBuddy 的聊天与聚焦桥接），不提供跨文件原子事务；其他载体或运行时注入应增加对应安装策略和验证，不能伪装成现有能力。

## CodeBuddy 的 hook 原理

详细分析过程、按钮事件如何定位、作用域和运行时事件链，见 [CodeBuddy 调查与注入说明](docs/codebuddy-investigation.md)。

其关键是：在包内 **ChatInput 函数作用域**中插入 React hook，因此可以访问该组件已持有的停止回调。新建对话调用已有服务，停止调用原按钮回调，保留暂停队列、取消请求与更新状态的流程。

安装过程修改磁盘上的 Webview JavaScript；应用重新打开后正常加载。运行时监听发生在应用自己的 Webview 内，无需 Raycast 常驻、系统全局键盘监听、坐标点击、调试端口或 dylib 注入。

当前 CodeBuddy 资源为：

```text
Contents/Resources/app/extensions/genie/out/webviews/main.942dbf9a.chunk.js
```

模块 ID、压缩变量名和插入锚点仅属于已分析构建。应用更新后需要重新分析，不能简单放宽摘要校验。

## 数据、迁移和恢复

新项目的数据按应用隔离：

```text
~/Library/Application Support/App Hook Studio/
  apps/<app-id>/
    settings.json
    backups/<原始 SHA-256>.original
```

CodeBuddy adapter 能识别先前已实测的 Esc/Esc 临时补丁，重建并核对原始字节后保存到新目录。运行时不依赖 `/private/tmp/codebuddy-hotkeys`。旧项目的设置如存在会作为只读迁移来源；首次在新项目保存时写入新位置，旧配置和备份不删除。

补丁包含设置元数据。检查时重新生成补丁比对，再核对剥离补丁后的原始摘要。相同设置重复应用不叠加代码；更改设置替换原补丁。遇到未知文件修改、版本变化或损坏备份则拒绝覆盖。

构建原始摘要：`ee829469ee2b4edd4c04f09f8b828840f196c82e22f5973d909ce6f29445c31f`。

可接管的旧临时补丁摘要：`1d6964015558e2d565f37e4421c863fe8729cf4c4492112f79b283ce1fa76cfe`。

## 安装前的只读预检查

App 安装确认页和 CLI 的 `preflight` 使用同一整体预检查流程；除以下资源检查外，也检查原生快捷键文件的格式与规则所有权：

1. 校验配置和应用 ID。
2. 确认构建、资源身份和已有补丁状态。CodeBuddy 同时核对版本与还原原文的 SHA-256，文件名或锚点相似不够。
3. 在内存中生成补丁，验证插入锚点唯一、剥离后原文一致、嵌入设置一致。
4. 由 adapter 验证完整候选资源。CodeBuddy 用 JavaScript 解析器检查语法，**不执行代码**。
5. 检查已有备份：缺失可以在正式应用时创建；损坏则阻止安装。

报告包含检查项、当前资源摘要、候选资源摘要和是否需要写入；遇到首个失败即停止，后续检查未执行。预检查不会创建数据目录、写备份、保存设置或替换应用资源。

**静态兼容通过不等于真实运行成功，也不保证已经取得写入权限。** 它只说明当前资源满足已验证构建和补丁的静态条件；真实会话中的行为仍需验收。不同版本必须先分析并增加对应 profile，不能用“语法通过”代替语义验证。

安装会重新执行整套检查，不把之前的报告当成持续有效的许可；聊天资源需要修改时，写入前还会确认应用已退出，并再次核对目标资源摘要。macOS 的实际写权限以正式写入时的结果为准。

## macOS 权限

发生 `Operation not permitted` 时，在 **系统设置 → 隐私与安全性 → App 管理** 中允许当前执行端（Raycast 或对应终端），重新打开执行端后重试。二者的授权不共享。该权限允许执行端修改其他应用，见 [Apple 说明](https://support.apple.com/en-au/guide/mac-help/mchl211c911f/mac)。

项目不会自动提权、改所有者、删除保护属性、关闭 SIP/Gatekeeper 或重新签名。**修改 `.app` 内的签名资源可能影响完整性校验，也可能被官方更新覆盖。** 如果应用无法启动，先退出并恢复；未知或更新后的构建需要重新核对，必要时从官方安装包恢复。

## CLI 与开发

```bash
npm run cli -- list
npm run cli -- status --target codebuddy-cn
npm run cli -- preflight --target codebuddy-cn  # 不写任何文件
npm run cli -- adopt --target codebuddy-cn
npm run cli -- apply --target codebuddy-cn      # 先退出目标应用
npm run cli -- restore --target codebuddy-cn    # 先退出目标应用
```

参数：`--app /path/to/App.app`、`--config /path/to/settings.json`（apply）、`--data-dir /path/to/app-data`。未指定 `--target` 时使用明确命名的默认 ID `codebuddy-cn`，不按注册表顺序隐式选择。检查与恢复默认使用 adapter 的应用路径，自定义路径时显式传入 `--app`。

```bash
npm run typecheck
npm test
npm run build              # 输出项目 dist/ 并执行产物加载检查，不安装到 Raycast
```

不把应用资源放进仓库。要在本地验证真实 CodeBuddy 文件的接管、更新、重复应用与逐字节恢复，可传入原始备份和旧补丁：

```bash
CODEBUDDY_TEST_ORIGINAL="/path/to/verified-original.js" \
CODEBUDDY_TEST_LEGACY="/path/to/verified-legacy.js" \
npm test
```

真实资源测试只在临时 fixture 目录中运行，不修改 `/Applications`；缺少输入时明确跳过。共享引擎的多 adapter 隔离测试使用合成资源，**不代表已支持第二个真实应用**。

最初的 CodeBuddy Esc/Esc 补丁由用户实测可用；项目化后的 UI 与可配置 hook 还需要端到端操作验收。编译、模拟键盘事件和文件恢复测试不能替代真实应用运行验证。

Raycast 文档：[创建扩展](https://developers.raycast.com/basics/create-your-first-extension)、[Form](https://developers.raycast.com/api-reference/user-interface/form)、[Manifest](https://developers.raycast.com/information/manifest)。

### Raycast 打包依赖回归检查

`jsonc-parser` 的默认 UMD 入口在 Raycast 打包时曾留下动态相对依赖，导致界面加载报 `Cannot find module './impl/format'`。生产代码显式使用其 ESM 入口，让静态依赖进入扩展包。

`postbuild` 和 `postinstall:local` 会实际加载生成的命令文件，拒绝遗留的未打包依赖，并检查入口能够创建 React 元素。检查仅替代 Raycast 私有 API，不模拟完整原生界面；它能覆盖这类“构建成功但加载失败”的问题，不能代替 UI 验收。

### App 版本字段

适配器通过 `versions.supported` 声明支持的 App 与内部组件版本，`versions.read(appPath)` 从所选包读取实际版本。App 列表显示支持版本；应用管理与整体安装确认页分别显示当前版本和支持版本。CodeBuddy 当前支持 `1.106.1 / genie 3.10.0`。版本不是用户可填写的兼容性豁免；未知版本仍需分析并添加构建 profile，安装同时检查资源摘要。

### 新增 App 与功能

App 列表的 ⌘K 菜单提供 **Add App / 新增应用**；功能列表提供 **Add Item / 新增功能**，两者使用 **⌘N**。支持安装的 App 行中，Enter 查看、⌘Enter 整体安装，新增放在第三个及之后的 Action，避免 Raycast 第二项默认 ⌘Enter 与安装冲突。当前新增条目保存到 `catalog-drafts.json`，显示为“待分析接入”草稿；可记录所选 App、目标版本、资源/事件和功能说明。新增草稿不会加入安装计划。code-agent 可通过 [本地 MCP](docs/mcp.md) 校验并注册可执行 Recipe v2；注册后显示在“MCP 注册应用”，再按 App 整体安装。现有 CodeBuddy 私有回调仍由内置适配器提供。

## 本地 MCP

运行 `npm run build:mcp` 生成 `dist/mcp.cjs`，使用绝对 Node 路径启动该文件即可连接。工具包含 `get_recipe_schema`、`list_apps`、`get_app`、`validate_recipe`、`register_app`、`register_items` 和 `preflight_app`。注册只写本地元数据；Raycast 中刷新注册应用后即可配置和整体安装。完整配置示例及 agent 操作步骤见 [MCP 使用说明](docs/mcp.md)。

### Raycast 提示 Command Out of Memory

聚焦桥接涉及约 21 MB 的扩展主文件，旧实现会在 Raycast 的 100 MB 命令堆内生成和解析多份大字符串。已改为独立 Node 进程处理大资源，UI 只接收检查结果；无需调整 Raycast 堆限制。构建会自动生成并打包辅助程序，重新安装本地扩展后，退出旧命令并重开即可。原因、受限测试与成本见 [内存修复记录](docs/raycast-memory.md)。
