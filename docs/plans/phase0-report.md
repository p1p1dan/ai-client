# Phase 0 Report — OpenChamber Chat Refactor

> Date: 2026-07-23  
> Environment: **normal developer machine** (no TEC/OCular TSD encryption)  
> Branch: `feat/openchamber-chat-refactor`  
> Authority: `docs/plans/2026-07-23-openchamber-chat-refactor-ard.md` §10

## Verdict: **Conditional Go**

选定主路线：**`stream-json`**（直接 `node cometix/cli.js --output-format stream-json`）。  
Agent SDK 路线可用作 fallback，本机实测能出结构化事件但首包 assistant 更慢、易超时。

TSD 解密与「打包产物在加密机上读文件」**未验证** —— 标为 **待加密机**，不得用本机结果冒充通过。

## Evidence matrix

| # | ARD §10.1 项 | 本机结果 | 备注 |
|---|---|---|---|
| 1 | Node 24 `process.execPath` + version | ✅ | `C:\Users\13927\AppData\Local\nvm\v24.18.0\node.exe` / `v24.18.0` |
| 2 | TSD 加密文件解密读 | ⏳ 待加密机 | 开发机无 `%TSD-Header-###%` 样本；`tsdSafeRead` 仍保留 |
| 3 | Cometix 固定 release + SHA256 | ✅ | `@cometix/claude-code@2.1.212`；tarball SHA256 `85c43e15b6ad0a28f7df833724262b100098db76a27c50b212c9e75b6d3ca404`（见 `src/agent-host/PINNED.md`） |
| 4 | Agent SDK 最小 Query → 结构化事件 | ✅ 部分 | SDK `0.3.218` 经 Cometix `cli.js`；40s 内收到 9 个 `system` 事件，assistant 未在超时前到达 |
| 5 | stream-json → 结构化 JSONL | ✅ | 5 事件：`system×3` + `assistant` + `result`；看到 Assistant Text |
| 6 | Stop / Resume / Permission | ⏳ 部分 | 未做完整成功路径 spike；Host stub 仅 handshake/shutdown。**进 Phase 2 前必须补** |
| 7 | Electron 启停 Host、无孤儿 | ✅（开发态） | `host-lifecycle-spike`：ready → shutdown → exit 0，PID 消失。打包态 ⏳ |
| 8 | Effort / Plan / Build 探测 | ⏳ | 未测；MVP 控件按 ARD 条件性隐藏 |

## Route selection

### Primary: `stream-json`

- Spawn: `node <cometix>/cli.js -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`
- Cometix version banner: `2.1.212 (Claude Code)`
- Structured events observed; assistant content present
- Known noise: SessionEnd hook failure (`Hook cancelled`) → process exit code 1，但不影响 JSONL 事件解析

### Fallback: `agent-sdk`

- `@anthropic-ai/claude-agent-sdk@0.3.218` + `pathToClaudeCodeExecutable` → Cometix `cli.js` + `executable: process.execPath`
- Import/`query()` 可用；能收到 NDJSON 风格结构化事件
- 本机冷启动偏慢；需 Abort/timeout；assistant 类型识别需按 SDK 事件形状再校准

## Known limitations

1. **TSD**：所有「白名单 Node 解密」验收必须在真实加密机重跑。
2. **Stop / Resume / Permission**：Phase 0 未闭环；Phase 2 Runtime Vertical Slice 的第一刀必须覆盖。
3. **打包 Electron → 外部 Node Host**：开发态 lifecycle OK；`electron-builder` 资源打包与 `resources/agent-host` 路径尚未验收。
4. **Agent SDK**：事件 type 命名与 stream-json 不同；Normalizer 需双适配。
5. **本机 Node 默认仍是 v22**（nvm）；Resolver 会找 nvm 下的 v24，也可设 `AICLIENT_NODE24_PATH`。

## Go / Conditional Go / No-Go

- **No-Go 条件均未触发**（有 Node 24；至少一条路线有结构化事件；Host 可启停）。
- 因 TSD + Stop/Resume/Permission + 打包态未齐 → **Conditional Go**。
- 允许进入 **Phase 1（已并行）** 与 **Phase 2**；Phase 2 开工清单必须含：Permission 桥、Stop、Resume（CC JSONL）、打包 Host 生命周期。

## Artifacts

- `src/main/services/agent-host/` — NodeRuntimeResolver / AgentHostProcess / AgentHostManager
- `src/agent-host/` — Host stub + spikes + pinned Cometix
- `src/shared/types/agentHost.ts` / `runtimeEvents.ts`
- `src/main/ipc/agentHost.ts`
- Phase 1 shell: `src/renderer/components/workspace-shell/` + mock chat store（Settings → Appearance → Beta）
