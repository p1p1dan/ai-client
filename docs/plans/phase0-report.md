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

## Addendum — 2026-07-23 多轮公平复测

脚本：`src/agent-host/spikes/compare-routes-multiturn.ts`  
设定：同机 Node 24 / Cometix 2.1.212；Turn1 记秘密 token → Turn2 `--resume` / `options.resume` 追问；超时 120s。

### 结果（本次）

两条路线 **都失败在同一点**：上游 API 连续 `503 server_error` + `api_retry`（最多 10 次），Turn1 根本没有 `assistant` 文本，因此 **连续会话召回无法判定**。

| 路线 | sessionId | 首包 assistant | 连续召回 |
|---|---|---|---|
| stream-json | 有 | 无（卡在 api_retry） | 未测成 |
| agent-sdk | 有 | 无（同样 api_retry / abort） | 未测成 |

补充：把之前“秒出 PONG”的短 query 重跑，同样只见 `system/init` + `api_retry`，`model=grok-4.5[1m]`，`apiKeySource=none`。

### 纠正此前时间差结论

**不能**用第一次 spike 的耗时差断定「stream-json 比 SDK 快」。更合理的解释是：当时 API 碰巧可用；SDK 那次撞上慢启动/重试/超时截断。底层都是同一个 Cometix `cli.js` + 同一模型网关。

### 连续会话能力（机制层，仍有效）

- stream-json：事件里带 `session_id`；CLI 支持 `--resume <id>` / `-c`
- Agent SDK：`options.resume`；另有 `listSessions` / `getSessionMessages` 等

→ **长上下文连续聊，两条路机制上都支持**；差在工程封装，不在“能不能”。正式对比需等 API 恢复后再跑同一脚本。

### 选型建议（更新）

在 Stop/Resume/Permission 未测完、且本次无健康 API 证据前：
- **不要把 stream-json 锁死为主路线**；保持 **双路线可切换**，Normalizer 双适配。
- Phase 2 先按 stream-json 落地也可以（实现简单），但 SDK 的 resume/abort API 仍值得保留为优先评估对象。

## Addendum 2 — 2026-07-23 API 设置修复后复测

用户更新 `~/.claude/settings.json` 后重跑。Spike 改为显式注入 `settings.env`（`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`→`cch-jyw.pipidan.qzz.io`）。

良性多轮（项目代号 `ORANGE-42` → resume 追问）：

| 路线 | Turn1 总耗时 | Turn1 首包 | Turn2 总耗时 | Turn2 首包 | 连续召回 |
|---|---:|---:|---:|---:|---|
| stream-json | 13.1s | 10.7s | 12.0s | 9.6s | ✅ `ORANGE-42` |
| agent-sdk | 12.8s | 10.4s | 11.2s | 8.9s | ✅ `ORANGE-42` |

结论：
1. **此前 503 / 假“耗时差”主要是 API/凭证问题**，不是路线架构差异。
2. **两条路都能连续会话**（`--resume` / `options.resume`），耗时同量级。
3. init 里仍报 `apiKeySource=none`，但实际鉴权已通（CCH AUTH_TOKEN）；Host 侧应继续注入 `settings.env`。
4. 选型：**双路线并列**；Phase 2 可先落地任一条，Normalizer 预留另一条。SDK 在 abort/permission API 上可能更省事，stream-json 更透明。
