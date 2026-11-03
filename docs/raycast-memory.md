# Raycast 100 MB 堆上限修复

用户报告 `Command Out of Memory`、`JS heap limit (100 MB)`。此前 CodeBuddy 的聚焦修复加入约 21 MB 的扩展主文件，`PatchEngine` 在 Raycast 命令内读取原文、生成候选、校验补丁并解析完整 JavaScript。它不传输图片或 base64，但大字符串和 V8 语法解析仍会占用大量堆。

单独对当前包生成完整安装计划的旧代码在一次 100 MB Node 测试中完成后占用约 94 MB JS 堆，接近命令限额；其他运行也可能在该限额失败。在 100 MB Worker 内另外保留 16 MiB 模拟 UI 开销，旧代码稳定触发 `ERR_WORKER_OUT_OF_MEMORY`。这里的预留是合成负载，不是测得的 Raycast UI 内存。

## 改动

- 聚焦 host adapter 声明 `resourceProcessing: "node-process"`；共享引擎的 inspect / preflight / apply / restore / adopt 都在此边界委托，避免仅移动语法解析、却仍在 UI 留下大文件副本。
- `assets/resource-worker.cjs` 是自动构建的独立程序。Raycast 通过官方 `environment.assetsPath` 找到它，使用当前 `process.execPath` 启动，无需安装另一份 Node。
- 子进程独立设置 256 MB 旧生代堆预算；Raycast 命令原有 100 MB 限制不变。资源源码、候选文本和语法解析结果不跨进程传输，只返回小型状态和检查报告。
- 同一命令内大资源操作串行。只读操作超过 30 秒终止并报告错误；写入操作等待原子替换及临时文件清理结束，不用同一个硬超时中断写入。子进程错误、缺失资源或版本不匹配都会返回失败，不按成功继续安装。
- 资源摘要、版本、唯一锚点、退出检查、备份、写后验证和恢复仍由同一 `PatchEngine` 执行；不执行目标 App 的代码。
- 构建检查确认辅助程序确实位于发布/安装 assets 内，并实际运行健康检查，避免只在源码目录中可用。

## 验证与成本

同样的 100 MB Worker + 16 MiB 合成 UI 负载下，新实现可生成三个功能、两份资源、11 个检查项的安装计划，命令堆约 60 MB。此测试使用真实包资源副本，未修改安装中的 App。

另外一次不添加合成负载的完整计划测量：命令侧堆约 41 MB、耗时 0.46 秒、`time -l` 报告 CPU 0.55 秒；20ms 的 `ps` 进程族 RSS 采样峰值约 380 MiB。这是单次、文件已被读取后的测量，未区分严格冷/热启动，也不建立速度收益或精确峰值。旧完成样本为 0.50 秒、CPU 0.54 秒、单进程最大 RSS 约 287 MiB。进程隔离主要解决 UI 堆限额，**不声称总内存更低**。

回归覆盖真实源文件的受限计划、独立进程安装、幂等、状态查询、逐字节恢复，以及辅助程序缺失后的错误和队列恢复。仍未完成真实 Raycast UI 的手动内存验收。

相关代码：`src/core/resource-worker.ts`、`scripts/resource-worker.ts`、`scripts/resource-memory-check.ts`、`tests/resource-worker.test.ts`。需要测试源文件时沿用 `CODEBUDDY_TEST_ORIGINAL` 和 `CODEBUDDY_TEST_HOST`，然后执行 `npm test`。
