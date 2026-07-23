# 团队轨道台账（👥 用户 + 同事）

> 归属：OpenChamber 气泡对话重构 — 团队轨道（常规实现 / GUI 打磨 / 真机与加密机验收）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §3
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：用户 / 同事（每完成一个 T-xx 任务加行，附验收证据与提交 hash）

## 任务状态

| ID | 任务 | 状态 | 认领人 | 备注 |
|---|---|---|---|---|
| T-01 | 真实 Project/Workspace 数据树 | 🟡 | Cursor | 无依赖，建议最先 |
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
| T-17 | Tool 真实调用 GUI 验收 | 🟡 | Cursor | **立即可做**（验收现有 Phase 2 成果） |

图例：✅ 完成 · 🟡 进行中 · ⬜ 未开始 · ❌ 阻塞

## 过程记录（按时间）

> 模板：`| 日期 | T-xx 节点描述 | 结果 | 验收证据（命令输出/操作记录/截图位置）+ 提交 hash |`

| 日期 | 节点 | 结果 | 证据 / 提交 |
|---|---|---|---|
| 2026-07-23 | T-17 认领 + Host 侧预检 | 🟡 GUI 待点验 | Cursor 认领。约定：**测试走网关** `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io`（token 不入库，临时 `CLAUDE_CONFIG_DIR`）。Node 24 下 `phase2-permission-smoke.ts` → ok:true（Write→permission→allow→tool.completed→PERM-OK；`baseHost: cch-jyw.pipidan.qzz.io`）。GUI 仍读 `~/.claude/settings.json`，点验前需把网关 env 写入该文件（或提需求给主线支持 Host 侧 CLAUDE_CONFIG_DIR 注入）。 |
| 2026-07-23 | T-01 真实 Project/Workspace 数据树（实现） | 🟡 待 GUI 验收 | Cursor 认领。不改 `chatSessions.ts`：`deriveChatWorkspaceTree` + `useSyncChatWorkspaceTree` 外部 setState 灌真实 repos/worktrees/temp；LeftNav 多 Project 折叠 + New Session 绑 workspace；App 传入 repositories。单测 3 绿；`pnpm typecheck` + biome(workspace-shell/App) 绿。验收：Beta 壳左栏见真实仓库/worktree → 选 worktree → New → 发 `pwd`。 |

## 给同事的快速上手

1. 必读顺序：ARD（§4 目标结构、§9 MVP 矩阵）→ 执行计划 §3（自己的任务）→ 总台账（当前状态）→ `CONTEXT.md`（术语）。
2. 开发验证：`pnpm dev` → Settings → Appearance → 打开 **OpenChamber Workspace Shell**（Beta 开关）→ 选 **Live Agent Host** 会话发 `Reply with exactly: PONG`。
3. **测试凭证**：本轮 Live/Host smoke **不要用本机默认 Claude 登录**；用网关 `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io` + 对应 `ANTHROPIC_AUTH_TOKEN`（写在 `~/.claude/settings.json` 的 `env`，**勿提交仓库**）。Host 侧脚本可用临时 `CLAUDE_CONFIG_DIR` 注入。（更新 2026-07-23：用户拍板测试凭证**统一落文档**，以执行计划 §4「测试凭证统一约定」为准；Host 侧 smoke 已内置 `spikes/testCredentials.ts` 自动注入，零配置）
4. 提交前三绿：`pnpm typecheck` / `pnpm lint` / `pnpm test`；提交规范见 `CLAUDE.md`（Conventional Commits，中文描述）。
5. 不要改的区域：`src/agent-host/**`、`src/main/services/agent-host/**`、`src/main/ipc/chat.ts`、`src/shared/types/runtimeEvents.ts`、`src/renderer/stores/chatSessions.ts`（属 Claude 主线，需要改提需求）。
6. UI 遵循 `docs/design-system.md`（@coss/ui 优先、OKLCH 语义 token、尺寸/间距规范）。
