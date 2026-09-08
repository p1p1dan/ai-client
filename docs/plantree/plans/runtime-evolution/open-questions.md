# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

| 问题 | 当前证据 | 处理节点 |
|---|---|---|
| Q5 Main 侧裸 `readFile` 读 worker 写的文件会得到什么 | **第一轮现场探针已跑（2026-09-08，新安装包 + 随包 Node worker）**：worker 自己写、自己读为明文；shell 重定向写的文件同样明文；会话 JSONL 前 16 字节明文；但**用户在文件管理器确认两个产物在盘上均为已加密状态**——六步探针全部透过白名单内的 node.exe 观察，区分不了「未加密」与「透明解密」。两条曾被当作反证的现象已排除：`SessionIndexService.ts:410` 读的是 **Main 自己写的索引 JSON**（非 worker 写的 JSONL），编辑器走的是本就 TSD-aware 的 `previewFileRead`。问题因此收窄到 Main 侧真正的裸读：`GitService.ts:670` / `:1364`（diff 的工作区一侧，读到密文不报错，`decodeBuffer` 静默出乱码）、`WorktreeService.ts:648` | 第二轮探针：一次性 git 仓库里由 agent 改 tracked 文件，在应用 diff 面板看「修改后」一侧是明文还是 `%TSD-Header-###%`；若正常，再从应用界面提交并回读，确认 Main 派生的 `git.exe` 是否把密文写进仓库。结论为密文时，P3-5/P4 把 Main 侧读工作区与会话内容统一走 `readFileTsdSafe`，不逐处打补丁 |
| Q6 P1-0 是否同时交付非 pipe 的 stdio 实现 | D11 要求不假设管道可用；现场只证明随包 Node + TUI PTY 可用，尚不能证明非交互 bash 管道、文件重定向或无损字节 adapter 在加密机上的效果。[契约草案](topics/p1-0-host-contracts.md)建议先提供 pipe + adapter 挂载点，禁止失败后自动重跑，真实载体验收仍在 P1-8/P4-6 | P1-0 实现前评审交付范围；若首版必须有非 pipe 实现，先做隔离探针，确认字节、资源上限和清理语义后补入契约 |

已收口（2026-09-08）：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent，照搬 PI-Desktop ADR 0062/0119 边界 |
| Q4 新旧后端对比用哪一版 Pi 协议依赖 | [ARD D12](../../../plans/2026-09-08-runtime-evolution-ard.md) — 用户拍板「版本影响不大，用新的」：新 runtime 保持 0.84.4，不回退对齐，版本差异在 P2-6 记为已知偏差 |
