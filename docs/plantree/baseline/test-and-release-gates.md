# Test & Release Gates

## 日常变更门禁

按改动范围串行执行：

1. 相关纯函数/contract/unit tests；Vitest 强制 `--maxWorkers=1 --no-file-parallelism`。
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`。
3. Agent Host/worker 有改动时：`NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host`。
4. `pnpm lint` 或限定文件的 `pnpm exec biome check ...`。
5. `git diff --check`。

不得把未运行的历史数字写成当前证据；每次 evidence 记录精确命令、文件/测试数、日期和环境限制。

## Resource safety

- 重任务前：`free -h`、`df -h . /tmp`，确认无遗留 vite/vitest/tsc/esbuild/builder/host process。
- 不并行运行全量测试、typecheck、build、packaging 或重型 Agent。
- 本机禁止一次性完整 Vitest 和整套 production build；拆小批，批次后复查/清理。
- 分阶段 Node build 默认 heap 1536 MiB；不足时停止重评估，不无上限重跑。
- packaged/全量门禁无法安全拆分时交 CI/高资源主机。

## Worker foundation gates（T29–T31）

- RPC correlation、timeout、dispose、worker exit/crash。
- single slot create/send/stream/stop/dispose terminal state。
- pool capacity、foreground/active/pending eviction guard、idle reclaim。
- session/runtime/generation stale-event filtering。
- multi-slot isolation、window owner routing。
- Cycle 1/2 queue/pending/Extension UI/model/permission focused regression。
- app close 后 process census 无 orphan utilityProcess。

## Session/import gates（T32–T35）

- Pi list/open/getBranch history fixtures；entryId preservation。
- incomplete/missing/corrupt/cross-cwd diagnostics。
- resume order：resumed → history → idle；duplicate/switch/late hydration races。
- tree node cap、stale response、rewind branch preservation、fork source isolation。
- import source hash/mode/mtime 不变；failure 无 discoverable partial target。
- dedupe/provenance/importer-version tests；unmapped tool 不执行。
- legacy deletion audit：无 Claude/Codex execution dependency、dead IPC/menu/type branch；ASR/readers/evidence 被保护。

## TUI/packaging gates（T36）

- Pi CLI 和 production dependencies 位于 Resources/extracted layout，可由随包 runtime 解析。
- absolute launch，不依赖系统 PATH/global npm。
- session-identified input/output/exit、generation stale-output filtering。
- GUI/TUI single-writer guard、failed launch rollback、crash/return-to-GUI。
- Windows/Linux/macOS 适用平台的 packaged verifier 与 terminal smoke。

## Release candidate（T37）

- scoped suites 全绿后再按资源许可分批扩大；main/Agent Host typecheck、Biome、diff check 全绿。
- packaged multi-session、permissions、queue、preview、history/tree/fork、import、TUI、crash recovery GUI matrix。
- bounded pool 长时运行、反复 reopen、idle reclaim、RAM/swap/disk 和 orphan 检查。
- MIT notices、migration wording、release notes、source immutability 和 rollback docs。
- 数据损坏、permission bypass、cross-session leakage、double writer、startup failure 为发布 blocker。

## 当前并行环境欠项

- Cycle 1 真账号 queue GUI 复点。
- 高资源主机/CI 的完整 renderer + packaged local-file/Monaco/PDF smoke。
- 这些不阻塞 T28/T29，但必须在 T37 关闭。

## GUI 开发入口

当前仓库文档化 dev 入口是 `node scripts/dev.js`；Pi smoke 可按需要设置 `AICLIENT_NODE24_PATH=<repo>/out-node-runtime/node` 与 `AICLIENT_SKIP_AUTH_GATE=1`。不得使用会重装/冲掉 native modules 的未经核实启动路径。更早 Claude/Codex `dev.env` 说明已归档在 [旧 baseline](../history/2026-08-31-pre-pi-only-baseline/test-and-release-gates.md)，不再作为 Pi-only 权威。
