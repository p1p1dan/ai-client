# 团队轨道台账（👥 用户 + 同事）

> 归属：OpenChamber 气泡对话重构 — 团队轨道（常规实现 / GUI 打磨 / 真机与加密机验收）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §3
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：用户 / 同事（每完成一个 T-xx 任务加行，附验收证据与提交 hash）

## 任务状态

| ID | 任务 | 状态 | 认领人 | 备注 |
|---|---|---|---|---|
| T-01 | 真实 Project/Workspace 数据树 | ⬜ | | 无依赖，建议最先 |
| T-02 | Session 生命周期 UI | ⬜ | | 等 C-07 |
| T-03 | Resume UI + 历史时间线 | ⬜ | | 等 C-06（CP4） |
| T-04 | Thinking 折叠卡 UI | ⬜ | | 等 C-05 |
| T-05 | Tool Card 增强 + Question 卡 | ⬜ | | Question 部分等 C-04 |
| T-06 | 消息元数据 + 错误/重试 | ⬜ | | 无依赖 |
| T-07 | Composer @ 文件引用 | ⬜ | | 无依赖 |
| T-08 | Model 选择器 | ⬜ | | 无依赖 |
| T-09 | 空/错/断状态 + 诊断面板 | ⬜ | | 无依赖 |
| T-10 | 打包版 GUI 手工点验 | ⬜ | | 等 C-02，→ CP2 |
| T-11 | **M2 加密机验收（现场）** | ⬜ | | 等 T-10，→ CP5 |
| T-12 | Phase 4：右栏 Git 面板 | ⬜ | | M3 后 |
| T-13 | Phase 4：右栏 Files 面板 | ⬜ | | M3 后 |
| T-14 | Phase 4：右栏 Context 面板 | ⬜ | | M3 后 |
| T-15 | Phase 4：Terminal Dock 接真终端 | ⬜ | | M3 后 |
| T-16 | Phase 4：新旧开关成熟化 | ⬜ | | T-12~15 后 |
| T-17 | Tool 真实调用 GUI 验收 | ⬜ | | **立即可做**（验收现有 Phase 2 成果） |

图例：✅ 完成 · 🟡 进行中 · ⬜ 未开始 · ❌ 阻塞

## 过程记录（按时间）

> 模板：`| 日期 | T-xx 节点描述 | 结果 | 验收证据（命令输出/操作记录/截图位置）+ 提交 hash |`

| 日期 | 节点 | 结果 | 证据 / 提交 |
|---|---|---|---|
| — | — | — | — |

## 给同事的快速上手

1. 必读顺序：ARD（§4 目标结构、§9 MVP 矩阵）→ 执行计划 §3（自己的任务）→ 总台账（当前状态）→ `CONTEXT.md`（术语）。
2. 开发验证：`pnpm dev` → Settings → Appearance → 打开 **OpenChamber Workspace Shell**（Beta 开关）→ 选 **Live Agent Host** 会话发 `Reply with exactly: PONG`。
3. 提交前三绿：`pnpm typecheck` / `pnpm lint` / `pnpm test`；提交规范见 `CLAUDE.md`（Conventional Commits，中文描述）。
4. 不要改的区域：`src/agent-host/**`、`src/main/services/agent-host/**`、`src/main/ipc/chat.ts`、`src/shared/types/runtimeEvents.ts`、`src/renderer/stores/chatSessions.ts`（属 Claude 主线，需要改提需求）。
5. UI 遵循 `docs/design-system.md`（@coss/ui 优先、OKLCH 语义 token、尺寸/间距规范）。
