# any3 Remote Hook 安装调查（2026-11-09）

## 根因：安装目录不是实际运行目录

目标为 `havocrao-any3.devcloud.woa.com:36000`，登录用户 root。旧远程安装器固定 commit `8e9c06cb4efccd833fc8edb84123652746908a7d`；该目录存在，且状态 `applied`、两项 `managed`、`changed:false`。这些结果只验证旧目录磁盘状态，并不证明当前窗口使用它。

只读读取 `/proc/*/cmdline` 得到：

- PID 1903013：`stable-22e67e2a976382fdb01b02588226f2cfd9e24dc3/node .../out/server-main.js`。
- PID 1904090：同一构建的 `out/bootstrap-fork --type=ptyHost`。
- 最新日志会话 `20261109T140326` 的 exthost 日志/堆栈也指向 `22e67e…`。genie 激活日志正常完成。
- 新构建宿主原文不存在 `app-hook-studio.codebuddy.focusInput`；旧构建已补丁宿主存在该字符串。

因此 `command ... not found` 的已证实根因是：**Hook 写进了旧构建，而当前服务端运行另一构建**。不是输入框 focus 失败，也不是 locale/nvm 警告导致命令消失。此前 apply 失败的最终异常未被保留，不能追溯断言其具体原因；重复 apply 的保护可能拒绝未恢复安装，但这不是本次已经取证的历史错误。

## 环境问题与诊断遗漏

- 默认 SSH 端口 22 不适用此目标，正确端口 36000。
- 远端默认 Python 3.6.8 不满足安装器 3.9+ 要求；可用解释器为 `/data/workspace/wxa-agent-eval/miniconda3/bin/python3.13`（3.13.11）。已增加自动探测。
- Raycast Toast 截断长信息；执行层原本又只保留 stderr 前 8192 字符，Python 3.13 traceback 的 Base64 源码行挤掉最终异常。已增加详情/复制和尾部保留。
- 本次手工命令使用 `LC_ALL=C LANG=C`，locale 警告不再出现；远端 nvm 的 npm prefix 提示仍存在，但预检查与安装均成功，没有修改用户 npm 配置。

## 新构建独立验证

两构建均标为 CodeBuddy 1.106.1 / genie 3.10.0，不能仅靠版本号复用。

| 资源 | 新构建原文 SHA-256 |
| --- | --- |
| 宿主 | `7a362fea9097bea1719a631a21126314f0218660e43a9df40b9f30cb9bd2810a` |
| Webview `main.4e7322ea.chunk.js` | `1100a2cbddd023c284b90b2b450e725301575ba6bdb3c6498649127c7888f702` |

静态调查不执行 App 代码：

- 宿主 module 786500 factory 参数为 `__unused_webpack_module,exports,__webpack_require__`，共享 `container`；唯一 anchor `}async function doActivate(ir,ar){` 前仍位于 `activate(ir)` 内、`await doActivate(ir,rn)` 后。host v2 可原样复用。
- 426850 为 VS Code API 外部模块；328150 导出 `ActivityBarChatWebviewProvider` Symbol；637830 导出 `ChatViewService` Symbol。provider/ChatService 所需方法仍存在。
- 新 Webview 是 TS `UPDATED_PROFILE` 已知摘要。新 anchor 为 `const{setNavigationAllowed:On,navigateToInputContextLast:xn}=`。
- 独立 v3 模板按 identifier token 映射：`Ce→ye`（取消）、`le→se`（生成状态）、`Ne→Le`（editor 模式）、`Re→Ae`（DOM ref）、`Ae→je`（面板查找）、`Ue→Ve`（editor ref）。不是顺序文本替换。
- requireAnchor 不变且唯一，ChatInput 内仍有局部 `var r` 遮蔽 factory require；继续在函数外保存 `cbHotkeysRequire`，不能在函数内直接调用 `r`。
- 新建服务调用与 focus editor/ACK 链静态保留；主 chunk 消费公共模块 `wGu3/vFXG`，本次没有独立分析公共 chunk 全部导出。
- 独立审查在内存注入后对两份完整 JS 做 Acorn 解析通过；安装器另外用目标服务端 Node 做完整候选 `--check`。

## 安装器修正

远程构建 allowlist 扩展为两个明确 profile，而非仅替换旧 COMMIT/HASH。默认从运行进程的完整 argv 确认实际构建；零个/多个/未知构建拒绝猜测。CLI `--commit` 允许明确指定已验证构建，供离线安装/恢复。

调查中稍后 `/proc` 已无服务端进程（未主动终止任何会话）。默认自动选择正确拒绝，因此使用此前进程与日志已确认的 `--commit 22e67e2a976382fdb01b02588226f2cfd9e24dc3` 完成后续操作。

真实资源本机副本的测试覆盖：预检查无写入、安装、拒绝重复 apply、外部修改拒绝、精确 restore、保留首次备份重装、损坏备份拒绝、focus 开关、未知 commit 拒绝。四项测试通过。

## 实际 any3 安装结果

按用户明确授权安装，使用默认三项全开（Ctrl+Cmd+N 新建、500ms 双 Esc 停止、Cmd+I 聚焦；IDE 绑定仍由本机管理）。新构建安装前两份均为可信原文，尚无安装记录，因此首次 apply，无需对新构建 restore。未修改旧构建及其备份。

执行顺序：显式新 commit preflight → apply → status，均退出码 0。apply 首次创建原文备份并写入；后续 status 为 `phase:applied`，两份 `kind:managed`、`changed:false`。

| 资源 | 安装后 SHA-256 |
| --- | --- |
| 宿主 | `5b2087857b416bee9cf329ae22611b2c7146de85f7038927f71b0ff85ac7b41c` |
| Webview | `4c8430395cd7957e0581e0b327e3ef577a11c4d2582e84dda319a1b186779834` |

备份目录（远端）：

```text
/root/.codebuddy-server-cn/bin/stable-22e67e2a976382fdb01b02588226f2cfd9e24dc3/app-hook-studio-remote-backup/
  host.before
  webview.before
  state.json
```

恢复命令（仓库根目录运行；保持同一解释器、用户、端口、commit）：

```bash
LC_ALL=C LANG=C python3 apps/quickstart/codebuddy-hotkeys-quickstart/remote_hotkeys.py restore \
  --host havocrao-any3.devcloud.woa.com --port 36000 \
  --python /data/workspace/wxa-agent-eval/miniconda3/bin/python3.13 \
  --commit 22e67e2a976382fdb01b02588226f2cfd9e24dc3
```

**验收边界：已验证真实远端磁盘安装与备份；未主动重启服务端，未完成真实窗口按键与焦点 ACK 验收。** 用户需重新连接 any3、打开聊天面板后测试；若仍失败，核对新会话实际构建与激活日志，不将 status 当作运行态命令注册证明。
