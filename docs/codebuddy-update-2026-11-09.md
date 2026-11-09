# CodeBuddy 同版本构建更新适配（2026-11-09）

## 故障原因

本机 App 与 genie 仍自报 `1.106.1 / 3.10.0`，但旧聊天入口 `main.942dbf9a.chunk.js` 已不存在，新入口为 `main.4e7322ea.chunk.js`。旧安装器仅按版本选固定路径，因而显示 ENOENT。仅改文件名不足以适配：ChatInput 压缩变量发生了变化。

本次只修改仓库适配器，没有写入已安装 CodeBuddy、用户 keybindings 或 hooks，也没有自动执行批准操作。

## 资源身份

- 新 Webview SHA-256：`1100a2cbddd023c284b90b2b450e725301575ba6bdb3c6498649127c7888f702`，3,546,628 bytes。
- 新扩展宿主 SHA-256：`3d269f1683a8547045a1fd383c8a565b78f1b05604b28831b8184824c1291ecc`，21,430,384 bytes。
- 保留旧 profile、旧管理块精确识别与原文恢复。备份仍以原文摘要隔离，不把旧构建备份写回新构建。
- 未知入口或两个已知入口并存会显式拒绝；入口名只用于选择，完整摘要才是允许修改的身份依据。core 继续独立核对所选 profile 摘要。

## Webview 调查

新版 ChatInput 属性/局部变量对应：

| 语义             | 原构建 | 新构建 |
| ---------------- | ------ | ------ |
| React            | `m`    | `m`    |
| onCancelSend     | `Ce`   | `ye`   |
| isStreaming      | `le`   | `se`   |
| editor 模式判断  | `Ne`   | `Le`   |
| section 容器 ref | `Re`   | `Ae`   |
| 聊天面板祖先查询 | `Ae`   | `je`   |
| 编辑器 ref       | `Ue`   | `Ve`   |

新唯一锚点为 `const{setNavigationAllowed:On,navigateToInputContextLast:xn}=`。原生 section 使用 `ref:Ae`；其 contenteditable 查找和面板查询均在该锚点前已建立。新建聊天仍由 `wGu3.ContainerUtil.get(vFXG.NewChatViewServie).startNewChat()` 发起。新版 hook 以词法 token 同步替换标识符，避免替换元数据、字符串或发生级联重命名；旧 v1/v2 生成内容不变。

## 宿主调查

宿主注入锚点 `}async function doActivate(ir,ar){` 仍唯一。插入代码位于 `activate(ir)` 内 `await doActivate(ir,rn)` 后，container 已初始化。静态核验保留：

- vscode 426850、ActivityBarChatWebviewProvider 328150、ChatViewService/ToolService 637830。
- ConversationManagerToken 302351、HookManager 946785、HistoryService 155735。
- ToolManagerListener 73280、SubagentToolListener 748749、NotificationManager 176998。
- 聚焦的 waitWebviewReady / ensureRpc / activatePage 方法，批准 listener 的确认/开始/完成方法，ToolService execute/cancel/ignore 与 ACP respondToPermission 仍存在。
- 未更改批准控制、身份契约、ACP NOT_READY 检查和原生调用链。

这些是静态分析，不代表所有冷启动、会话切换和主/子任务批准的真实 UI 生命周期均已实测。

## 验证与使用

新增测试覆盖同版本入口选择、未知与歧义入口拒绝、新词法绑定下停止/新建/聚焦，以及真实新资源的内存注入、完整语法解析、剥离后逐字恢复、篡改拒绝。真实资源不纳入仓库：

```bash
CODEBUDDY_TEST_UPDATED_ORIGINAL='/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/webviews/main.4e7322ea.chunk.js' \
CODEBUDDY_TEST_UPDATED_HOST='/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/out/extension/index.js' \
node --import tsx --test tests/codebuddy-builds.test.ts
```

更新 Raycast 扩展：`npm run install:local`。保存工作并完全退出 CodeBuddy，进入 Manage App Hooks → CodeBuddy CN，先查看整体安装预检，再执行整体 Install，重启应用后实测新建、双 Esc、⌘I 和批准通知/外部批准。若官方更新已替换原资源，不要把旧构建原文手工恢复到新入口；安装器会为当前构建建立独立备份。若检测仍为旧管理资源则使用正常 Restore 流程，不覆盖未知改动。

独立 quickstart 的 Python/manifest 仍固定旧构建，本次未更新、不应对新版使用。
