# CodeBuddy hack 安装／恢复互相阻断处理记录

处理日期：2026-11-10。本次直接处理本机文件，未修改安装器源码。

## 现象与原因

Install 预检报错：`发现旧版安装，请先 Restore 完整恢复，再 Install`。
整体 Restore 预检报错：缺少 `focus-keybinding/before.jsonc`，无法证明旧安装前的完整原状。

现场检查发现：

- CodeBuddy CN 已退出，仅有 crashpad 辅助进程，没有安装／恢复任务或残留 `operation.lock`。
- 当前 Webview 为新版 `main.4e7322ea.chunk.js`，摘要为 `1100a2cbddd023c284b90b2b450e725301575ba6bdb3c6498649127c7888f702`，是已验证的原始资源。
- 宿主资源也通过当前构建预检；两份资源均可正常生成、解析和剥离补丁。
- 应用包内 `app-hook-studio-backups` 不存在，默认用户数据目录 `~/Library/Application Support/App Hook Studio/apps/codebuddy-cn` 也不存在。
- 用户 `keybindings.json` 仍含 `app-hook-studio:focus-input` 和 `app-hook-studio:new-chat` 两个旧规则标记。

因此这是安装状态与备份缺失造成的逻辑互锁，并非进程锁死：Install 防止把旧补丁当作原始基线，Restore 则拒绝在没有可信旧备份时宣称完整恢复。备份为何消失、是否由应用更新或数据清理造成，现有证据不足，不能确认。

## 手动处理

1. 先将原快捷键文件保存到仓库 `recovery/codebuddy-2026-11-10/keybindings.before-manual.jsonc`。
2. 只清理上述两个可明确归属旧安装的规则。移除聚焦规则时，JSONC 编辑器同时移除了相邻的新建规则注释；随后依据现场副本核对并移除了对应旧规则，未将其误作用户规则保留。
3. 对清理前后解析出的规则作逐项比较，确认其他 14 条用户规则内容与顺序均一致。清理后的文件保存为 `keybindings.clean-baseline.jsonc`。
4. 使用当前适配器安装资源补丁、聚焦／批准桥接和聚焦快捷键，建立新的完整快照。过程中的首轮快照与用户数据保存在同一 recovery 目录下的 `first-cycle-whole-app`、`first-cycle-data`，未冒充历史备份。
5. 用 `prepareAppRestore(...).execute(...)` 执行真正的整体恢复，再逐一校验两个资源和快捷键的 SHA-256；快捷键也逐字比较新基线。
6. 最后重新整体安装，保留可用的已安装状态。

新基线是本次明确清理后的状态，不能声称是已经丢失的历史安装前文件。没有创建空备份或伪造旧安装记录。

## 验证与最终状态

- 安装预检通过，包括构建身份、补丁可逆性、完整 JavaScript 静态解析。
- 整体安装返回 `complete: true`，所有步骤完成。
- 整体恢复实际执行成功，三个目标摘要均等于快照的 `before`，快捷键逐字等于本次清理后的基线。
- 恢复后再次安装成功，最终快照阶段为 `installed`，原文备份与完整恢复记录已建立。
- 未启动 CodeBuddy，也未实测聊天、双 Esc、⌘I 或真实批准请求；重新打开应用后仍需验证这些运行时行为。

当前恢复记录位置：

```text
/Applications/CodeBuddy CN.app/Contents/Resources/app-hook-studio-backups/whole-app/state.json
```

## 后续操作注意

正常恢复请使用 Raycast 的整体 Restore 流程。当前 `scripts/cli.ts` 的 `restore` 命令调用的是 `restoreAppResources`，只恢复资源，没有调用整体快照恢复；本次验证专门使用 `prepareAppRestore`，避免资源恢复与完整快照状态再次脱节。这个 CLI 行为本次未修改。

以后再次遇到类似情况，先核对资源摘要、快照、用户数据及所有权标记，再决定恢复方式。不要直接删除记录、把当前文件复制成历史备份，或把旧构建资源覆盖到新构建。

`recovery/` 包含用户快捷键与较大的资源备份，是本机现场留存，不应作为通用示例或自动提交的源码。
