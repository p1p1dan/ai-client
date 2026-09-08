# B4 多来源扫描与事务导入接入

> 历史检查点。最终状态见 [完成记录](./completion.md)，下文的当时未完成项或阻塞已由后续证据替代。

日期：2026-09-08。未提交；B4 主链路已接入但完整验收未关闭。

## 改动

- `CodexSessionScanner.ts`：按年月日目录发现 rollout，逐文件有界读取，检查读取前后状态；摘要不保留完整会话。坏文件跳过；来源根扫描失败由上层隔离。
- `CodexSourceAdapter.ts`：转换为既有 ImportedConversation，提供发布前指纹复验。
- `LegacyImportSources.ts`：source/scan/convert 接口；扫描串行执行，单源失败不隐藏其他来源。
- `LegacyImportService.ts`：按来源选择 converter，保持 manifest/原子 writer/index/rollback 路径；新目标 ID 含来源，去重仍使用完整指纹机制。
- shared guards 支持 codex，importer version 升为 `b4-legacy-v2`；manifest 与 session index provenance 兼容 codex。
- IPC/preload/hooks/UI 传递来源；query key、项目选择和 React key 包含来源，列表显示 Codex/Claude Code。
- Pi writer 保持来源无关，缺少模型时不再硬编码 claude；来源接口位于 Main 的原因已登记在计划 README。

## 实际验证

命令前缀：`NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/vitest run`，后缀：`--maxWorkers=1 --no-file-parallelism`，各批串行：

- `src/main/services/legacyImport/__tests__/CodexSessionScanner.test.ts`：5 tests 通过，覆盖发现/有界摘要、源不变、内容变化指纹、坏文件、错误根、adapter 契约与发布前变化拒绝。
- `src/shared/types/__tests__/legacyImport.test.ts src/main/services/legacyImport/__tests__/ClaudeSourceAdapter.test.ts`：2 files / 10 tests 通过。
- `src/main/services/legacyImport/__tests__/LegacyImportService.test.ts`：10 tests 通过，包含 Codex 连续导入第二次 already-imported、只创建一次、签名 manifest 重新读取、Codex 根 ENOTDIR 时 Claude 项目仍返回。
- `src/renderer/components/sessions/__tests__/legacyImportUiStatic.test.ts`：4 tests 通过。
- `src/agent-host/__tests__/piLegacyImport.test.ts`：2 tests 通过；真实 Pi SDK writer 分别写入 Claude/Codex 来源，验证 native v3 历史、provenance、context 排除 display、reconcile 清理。
- Root `tsc --noEmit`、Agent Host `tsc --noEmit -p src/agent-host/tsconfig.json` 均以 1200 MiB 堆运行通过。
- 本轮导入相关 26 个文件 `biome check` 通过，无诊断；`git diff --check` 通过。

## 未完成

- parser→adapter→真实 writer→重新打开的联合探针（当前各层分别验证）。
- 跨来源同名 externalId 的服务级回归（已有去重 key 来源不同断言）。
- 旧 protocol history reader 复用裁定：它不直接解析 rollout，不得伪装复用。
- 真实 Electron GUI 累计点验、B1 worker/TUI、B2 subagents 目录结论、最终串行小批门禁。
