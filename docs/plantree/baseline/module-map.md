# Module Map

> 模块键用于 plan 的 affected-module 描述。目标 ownership 以 D15 为准；“Transition”表示代码仍存在但不是最终边界。

## Stable modules

| Key | 路径 | 当前/目标职责 |
|---|---|---|
| `MAIN` | `src/main/` | Electron lifecycle、IPC、window/session owner、service composition |
| `WORKERS` | `src/main/services/agent-host/` | **目标**：Main-owned WorkerManager、bounded WorkerSlot、capacity/remap/crash/reclaim；当前仍含 singleton manager/process |
| `PRELOAD` | `src/preload/` | contextBridge 与窄 IPC；不拥有 runtime state |
| `RENDERER` | `src/renderer/` | React UI、Zustand session buckets、timeline、queue/pending、Extension UI surfaces、model/composer |
| `PI_WORKER` | `src/agent-host/` | **目标**：utility worker entry、Pi AgentSession/SessionManager/extensions/RuntimeEvent projection |
| `CONTRACTS` | `src/shared/types/` | IPC、RuntimeEvent、session/history/model contracts；renderer 与 Pi SDK 的唯一汇合点 |
| `SESSION` | `src/main/services/chat/` + related stores | SessionIndexService、runtimeIdentity、owner routing、retirement and history navigation |
| `IMPORT` | planned under Main/worker services | Claude/Codex read-only adapters、ImportedConversation、atomic Pi writer、dedupe/provenance |
| `TERMINAL` | `src/main/services/terminal/` + `src/renderer/hooks/useXterm.ts` | node-pty/xterm、AgentTerminal；T36 接 Pi TUI controller |
| `CONFIG` | Pi model/auth/permission services + `~/.pilab` layout | managed/local credential mode、isolated Pi agentDir、models/auth/policy |
| `FILES_GIT` | file/git services + renderer surfaces | workspace preview、git/worktree；独立于 conversation runtime |
| `PACKAGING` | `scripts/` + `electron-builder.yml` | worker/CLI/resources build、afterPack、packaged verification |

## Target ownership

```text
RENDERER → PRELOAD → MAIN/WORKERS
                         ├─ WorkerSlot A → PI_WORKER process A
                         ├─ WorkerSlot B → PI_WORKER process B
                         └─ TERMINAL Pi TUI process (single-writer guarded)
```

- `MAIN/WORKERS` 管 pool、route、capacity、generation 和 worker lifecycle。
- `PI_WORKER` 管 Pi SDK/SessionManager/extension runtime，不管 window/UI。
- `SESSION` 管 durable product navigation；Pi session file 是 durable runtime identity。
- `IMPORT` 只读取 legacy source，不具备执行 Claude/Codex 的能力。

## Transition / replacement inventory

以下仍存在于代码，但不代表目标架构：

- `AgentHostManager` 同时拥有 legacy `AgentHostProcess` 与 singleton `PiHostProcess`；
- `claudeRuntime.ts`、`codexRuntime.ts`、bridges/readers/normalizers/settings/spikes；
- shared/renderer 中 Claude/Codex agent discriminants、agent picker/binding；
- agent-host package 中 Anthropic/Cometix/Codex dependencies；
- standalone/bundled Node 24 与旧 Agent Host packaging assumptions。

精确 retain/adapt/replace/delete 分类属于 roadmap T28；T28 前禁止按文件名机械删除，尤其要保护 Codex ASR、legacy import readers、evidence 和非 conversation provider/model metadata。

## Constraints

- `src/agent-host/**` 必须单独跑 `pnpm typecheck:agent-host`；根 typecheck 不作为其替代。
- Renderer 不直接 import Pi SDK 类型。
- Main 不直接运行 Pi SDK。
- Extension UI blocking/display state、queue/pending 和 session retirement 必须按 logical session + slot generation 隔离。
