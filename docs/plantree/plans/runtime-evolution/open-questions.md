# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

| 问题 | 当前证据 | 处理节点 |
|---|---|---|
| Q4 新旧后端对比使用哪一版 Pi 协议依赖 | P2-0 实测旧 `pi-coding-agent@0.84.3` 从自身嵌套 node_modules 加载 `pi-ai@0.84.3` 与 `pi-agent-core@0.84.3`；P0 新 runtime pin 两者 `0.84.4`。P0 文档中“与旧后端解析版本一致”的假设不适用于本次实际采集路径 | P2-6 前对齐协议依赖版本，或补采同参数的版本对照来量化差异；不得把协议包变更的影响直接归为新 runtime 效果。证据见 [正式基线 manifest](evidence/p2-0/baseline-20260908/manifest.json) |
| Q5 载体切换后 worker 写的文件 Main 能否读到明文 | 加密驱动按进程放行明文（`src/main/utils/tsdSafeRead.ts`）。D11 把 Windows GUI worker 从白名单外的 Electron 换成白名单内的随包 node.exe，worker 新写的会话 JSONL / compaction record / Write·Edit 产物在盘上的形态可能随之改变；而 Main 仍是 Electron，`SessionIndexService.ts:410`、`GitService.ts:670` / `:1364`、`WorktreeService.ts:648` 都是裸 `readFile`，全仓仅 `previewFileRead` 与 legacy import 三处 TSD-aware。**这是推断，不是已证事实** | P3-5 设计前需现场一条确认：worker 写入 → Main 读取 → 内容是否为明文。若为密文，收敛方案是 Main 侧读会话/文件内容统一走 TSD-aware 读，而不是逐处打补丁 |

已收口（2026-09-08）：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent，照搬 PI-Desktop ADR 0062/0119 边界 |
