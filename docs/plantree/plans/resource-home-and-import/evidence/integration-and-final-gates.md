# 联合取证与最终门禁

> 历史检查点。最终状态见 [完成记录](./completion.md)，下文的当时未完成项或阻塞已由后续证据替代。

日期：2026-09-08。B1–B4 主实现与关键验证已完成，合入门禁仍有下述失败，计划保持 In Progress。

## 已通过的联合验证

- `node scripts/probes/b1a-shared-skills-probe.mjs`：Pi 0.84.3；managed/local 的真实 Electron utilityProcess 均加载共享技能，scope=user；绝对 Node + bundled Pi CLI 在真实 PTY 中发现技能，tuiPtyVerified=true。无模型请求、无真实用户文件修改。
- `CodexImportIntegration.test.ts`：真实脱敏 rollout→scanner→adapter→真实 Pi 0.84.3 SDK writer→reopen，通过；源字节不变，legacy tools 仅历史展示，不进入 context。
- `LegacyImportService.test.ts` 11 tests：包含跨来源同名 externalId 创建两个不同会话、Codex 二次导入 already-imported、签名 manifest 重读、坏 Codex 根不隐藏 Claude。
- `codexHistoryReader.test.ts` 18 tests、`codexItemMapper.test.ts` 33 tests 与 `CodexRollout.test.ts` 4 tests 通过。磁盘 adapter 复用 mapper 的 `readCodexTextContent`，保留磁盘文本分隔；协议 reader 不冒充磁盘 reader。
- B2 目录结论见 [borrow surface](./b2-borrow-surface.md)。不采用 PI-Desktop 私有 subagents 目录符合排除 subagent 改造的范围。

## 全仓分批门禁

完整文件清单、命令与各批 summary：[final-batch-gate.json](./final-batch-gate.json)。
303 files，38 批，每批最多 8 files，maxWorkers=1/no-file-parallelism。
300 files 通过、3 files 失败；4519 tests 通过、3 tests 失败，另一个 suite 因缺 native 模块未能收集。

仅第 13 批未全绿：

1. `SessionManager.test.ts` 两条测试、`PiTuiPty.test.ts` suite：共享 node_modules 缺 Linux pty.node。
2. `SearchServiceRipgrep.test.ts` 一条：SearchService 仅排除 `.git/**`，worktree 的 `.git` 指针文件仍返回。此文件未被 B 组修改。

第 5 批曾发现新增文案以 `import` 结尾触发 electron-vite esm shim 防回归检查。
改为 `retry the import step` 后重跑该批通过；清单记录的是修正后的结果。

Native 环境调查：本机无 make/g++，sudo -n 需密码。只读检查官方 node-pty@1.1.0 tarball，只有 Windows/macOS prebuild，没有 Linux；没有改动共享 node_modules 或系统配置。
原始批次日志保留在 `/tmp/aiclient-b-test-gate`，摘要已入库，不依赖临时目录才能知道结果。

## 其他检查与交接

- Root 和 Agent Host `tsc --noEmit` 均以 1200 MiB 堆运行通过。
- 新 source 模块纳入 `legacyImportStatic.test.ts`，2 tests 通过，保证无 legacy runtime/launcher/process 接入。
- `git diff --check` 通过。未运行整套生产构建。
- GUI 按计划交接 [UI 对齐累计轮次](../../pix-ui-alignment/implementation-status.md)，追加资源页目录按钮/清单开关、双来源选择、重复导入与打开继续点验；尚未声称实际 GUI 通过。
- 全仓门禁未绿前不归档、不提交合入；native 依赖和 worktree 搜索基线仍需处置。

**后续状态更新**：native 已无管理员权限编译补齐并复验通过；当前 302 files / 4531 tests 通过，仅 worktree 搜索基线 1 file / 1 test 失败。见 [native 门禁恢复](./native-gate-recovery.md)。
