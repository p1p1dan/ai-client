# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

| 问题 | 当前证据 | 处理节点 |
|---|---|---|
| Q5 载体切换后 worker 写的文件 Main 能否读到明文 | 加密驱动按进程放行明文（`src/main/utils/tsdSafeRead.ts`）。D11 把 Windows GUI worker 从白名单外的 Electron 换成白名单内的随包 node.exe，worker 新写的会话 JSONL / compaction record / Write·Edit 产物在盘上的形态可能随之改变；而 Main 仍是 Electron，`SessionIndexService.ts:410`、`GitService.ts:670` / `:1364`、`WorktreeService.ts:648` 都是裸 `readFile`，全仓仅 `previewFileRead` 与 legacy import 三处 TSD-aware。**这是推断，不是已证事实** | P3-5 设计前需现场一条确认：worker 写入 → Main 读取 → 内容是否为明文。若为密文，收敛方案是 Main 侧读会话/文件内容统一走 TSD-aware 读，而不是逐处打补丁 |

已收口（2026-09-08）：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent，照搬 PI-Desktop ADR 0062/0119 边界 |
| Q4 新旧后端对比用哪一版 Pi 协议依赖 | [ARD D12](../../../plans/2026-09-08-runtime-evolution-ard.md) — 用户拍板「版本影响不大，用新的」：新 runtime 保持 0.84.4，不回退对齐，版本差异在 P2-6 记为已知偏差 |
