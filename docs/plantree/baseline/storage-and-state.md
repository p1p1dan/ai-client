# Storage & State

## Durable state

| 数据 | 位置/权威 | 说明 |
|---|---|---|
| App settings | `~/.pilab/<profile>/settings.json` | credential mode、产品设置；Main-owned keys 不允许 renderer 整份写回覆盖 |
| Credential vault | `~/.pilab/<profile>/credentials/vault.json` | safeStorage envelope；Pi arm 可选；不把 key 写进 models.json |
| Managed Pi agentDir | `~/.pilab/<profile>/pi-agent/` | isolated `models.json` / `auth.json` / settings/packages；登录模式使用 |
| Local Pi config | 用户自己的 Pi agentDir | local/BYOK 模式；应用不接管或重写整棵用户配置 |
| Session index | Electron `userData/session-index.json` | Main `SessionIndexService`；产品导航、logical session 与 runtimeIdentity/sessionFile |
| Pi conversation history | Pi native session JSONL | durable conversation/branch identity；WorkerSlot 内由 Pi SessionManager 读写 |
| Import manifest | T34 待定位置 | source identity/hash、importer version、target session、dedupe/failure state |
| Legacy Claude/Codex source | 原工具目录 | **只读 migration source**；永不 move/rename/delete/modify |

## Transient state

| 数据 | Owner | 生命周期 |
|---|---|---|
| Worker pool/slot map | Main WorkerManager | app lifetime；slot idle/crash/dispose 可回收 |
| Slot pending RPC/generation/active turn | WorkerSlot | slot generation；restart 必须清空 |
| Pi AgentSession/SessionManager | utility worker | worker process / opened durable session |
| Chat messages/timeline buckets | renderer Zustand | logical session；history hydration 可替换/merge |
| Queue/pending user messages | renderer session store | memory-only 首版；retirement/archive/repository remove 清理 |
| Blocking Extension UI | renderer dialog store + Main slot route | request/session/runtime/generation；ACK/cancel/reset/close 清理 |
| Status/widget/unsupported/notifications | renderer display store | session/runtime；reset/retirement 清理，有 bounds |
| TUI PTY state | Main terminal controller | session/generation；exit/dispose and mode switch cleanup |

## Identity rules

- logical application `sessionId` 用于 UI/store/navigation。
- normalized Pi `sessionFile` 是 durable Pi runtime identity。
- `runtimeIdentity` 是应用持久映射，不得混用为 transient worker PID。
- `worker generation` 只用于过滤迟到事件，不落为 session identity。
- workspace/cwd 是安全约束和 create temporary key 的组成，不替代 session file。

## Import provenance

建议双写：

1. Pi JSONL custom provenance entry，使 session 自描述；
2. 独立 manifest，使跨 importer 版本 dedupe 和失败恢复可控。

分享 transcript 时不得无条件暴露绝对 source path；可存 hash/stable identity，并把本机绝对路径限制在私有 manifest。

## Transition notes

当前代码仍含 Claude/Codex history/config/runtime state。它们在 T28 分类前只作为 replacement/migration source；新功能不得继续向 legacy execution storage 增加权威。
