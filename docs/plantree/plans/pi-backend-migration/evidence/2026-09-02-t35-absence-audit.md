# T35 Pi-only absence audit evidence

**日期**：2026-09-02  
**分支**：`feat/pi-primary-backend`  
**提交**：`cb0eddb5`、`821477b1`

## 已闭合

- 删除 Claude provider/config/completion/IDE MCP 的 Main IPC、preload、renderer settings 与 active service/test。
- 删除 one-shot Claude/Codex/Cursor/Gemini executor，改为 Main-owned `PiUtilityService` + ephemeral Pi worker。
- utility worker 使用 Pi `ModelRuntime.streamSimple`，不创建 `AgentSession`、session JSONL 或 `SessionIndex` row；有 bounded capacity、exactly-once terminal、timeout/cancel/dispose。
- one-shot commit message、branch name、code review、todo polish 保留原 prompt/parse/product API 语义，并统一为 Pi `model` / `effort`。
- settings migration 删除 provider、bare、reasoningEffort、claudeEffort；bare legacy model 不被猜测为 Pi identity。
- 保留项静态证明：Claude import scanner/source adapter、Codex history reader/mapper 与 fixtures 未被修改，且无 execution runtime import。
- `src/main` 无 Pi SDK import；Pi SDK 只在 agent-host worker 侧加载。

## 验证

- `pnpm typecheck`：通过。
- `pnpm typecheck:agent-host`：通过。
- focused serial Vitest：61 tests 通过；追加 T35 protected/import static gate：10 tests 通过。
- Biome scoped check：通过。
- `git diff --check`：通过。
- Worker-only build 未在本批次重复执行；完整 production build/full Vitest 受低资源主机约束未运行。

## 未闭合边界

以下不是 T35 可机械删除的残留，而是 T36 明确承接的 terminal/PTY/CLI packaging surface：

- `AgentTerminal`、CLI detector/installer、agent picker 与 custom agent command；
- remote helper 的 CLI command metadata；
- bundled Pi CLI 的 absolute path、PTY lifecycle、GUI/TUI single-writer 和 packaged smoke。

这些路径当前仍能表示或启动非 Pi CLI，故 T35 总验收尚未宣称完成；T36 必须完成替换或明确删除后，T35 才能最终 close。
