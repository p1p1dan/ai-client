# Evidence — T34 Claude legacy conversation import

**Date**：2026-09-01
**Role**：evidence
**Status**：accepted / T34 Done
**Related**：[roadmap](../roadmap.md#t34--read-only-legacy-import-service--done) · [D18](../decisions/018-t34-claude-import-semantics.md) · [T34 contract](../topics/t34-legacy-import.md)

## Claim verified

T34 已按 D18 闭环 Claude-only legacy conversation import：

```text
read-only Claude source
→ versioned ImportedConversation
→ display-only legacy tool/custom projection
→ worker-only staged Pi v3 JSONL
→ Pi native exact-open/history/context validation
→ atomic publish + private manifest + complete SessionIndex row
→ batch report → explicit open → exact-file resume → continue in Pi
```

原 Claude source 保持不变；相同 snapshot 去重，source hash 变化创建新 session；失败与 crash reconciliation 不保留可发现半成品；legacy tool/custom 不执行且不进入 LLM context；旧 Resume Claude IPC/preload/store/UI authority 和重复 Claude history readers 已删除。

## Landed implementation

### Contract and source adapter

- `src/shared/types/legacyImport.ts` 定义 source-neutral schema、fingerprint、batch/result/worker contracts、runtime guards 与 100-item batch / 64 MiB source / 2 MiB line / 4000-entry bounds。
- `src/main/services/legacyImport/ClaudeSessionScanner.ts` 迁入 migration-only namespace；project/session ID 拒绝 path traversal，renderer preview 不携带 source path。
- `ClaudeSourceAdapter.ts` 完整流式读取非-sidechain主线，前后 SHA-256/size/mode/mtime 验证；malformed、oversized、读取期增长和 user-only source 明确失败/诊断。
- Claude tool input/result经递归敏感键、token与binary redaction后保留为display-only历史；unknown custom/attachment raw payload不写入目标，所有legacy tool/custom均不成为native tool context。

### Pi writer and transaction

- `src/agent-host/piLegacyImport.ts` 只通过 Pi public `SessionManager` append APIs 生成 staging JSONL；使用普通 `custom` entry 保存 provenance/display state，因此不参与 `buildSessionContext()`。
- staged file 经 bounded preflight、Pi exact-open、history projection、context leak check 后，在同一 filesystem 原子 rename 到默认 Pi session directory，再次 exact-open 验证。
- Main `LegacyImportManifest` 保存私有 source path/fingerprint/dedupe/target 状态；record使用OS safeStorage保护的独立HMAC key做完整性校验，损坏/篡改记录隔离；JSONL provenance只含脱敏identity/hash/version。
- `LegacyImportService` 实现 immutable snapshot dedupe、single-flight、source pre-publish recheck、complete index transaction、commit前rollback、commit后dispose failure不回滚，以及importing/failed startup reconciliation；manifest路径不由Main直接删除，worker只检查/清理默认Pi目录内经header/session-id验证的文件，index row另带import ownership proof。
- create/reconcile 临时 utility worker 均由 Main `WorkerManager` 跟踪，app shutdown/force-kill 可覆盖进行中的 import/reconciliation。

### IPC and UI

- IPC/preload 收敛为 `legacyImport.listProjects/listSessions/importBatch`，runtime guard拒绝 malformed、oversized、separator/`..` traversal payload。
- Session Manager 改为 scan/preview/checkbox select/import/report/explicit open；默认不选，单条和批量都不自动打开。
- 成功项显式 Open 后作为 exact-file resumable Pi session 物化，刻意不标记为已 host-bound，首次发送先执行 Pi resume/history hydration。
- 文案只表达“只读复制历史，并在 Pi 中继续”。

## Replacement deletion

删除：

- `src/agent-host/historyReader.ts` 与旧 Claude history reader tests；
- `src/main/ipc/claudeSessions.ts`、`src/renderer/hooks/useClaudeSessions.ts`、`src/shared/types/claudeSession.ts`；
- `src/main/services/claude/ClaudeSessionScanner.ts`（迁入 legacyImport namespace）与 `sessionLogReader.ts`；
- renderer `resumeClaudeSession` store action、`ProjectGroup.tsx` 和 Resume Claude wiring。

Codex `codexHistoryReader.ts` / `codexItemMapper.ts` 仍是静态隔离的 migration-only future adapter asset；本轮不宣称 Codex 本地 importer。

## Reference disposition

### pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）

- **Adapted**：session metadata/preflight、public SessionManager exact-open/history/context validation、staged failure scenarios。
- **Rejected**：Main直接解析Pi JSONL、private SDK deep import、best-effort SQLite index、fixed sleep作为flush/dispose contract。
- 本轮按 public API/行为独立实现，没有复制 substantial upstream source/test block；无需新增 distributed source notice，T37 license audit继续保留reference ledger。

### pix `da01b3e12d2e`

T34未采用pix实现；其PTY/TUI、single-writer和CLI packaging继续留给T36。

## Verification

所有 Vitest 使用 `--maxWorkers=1 --no-file-parallelism` 串行执行；未运行 full Vitest 或整套 production build。

```text
T34 focused unit/contract/static regression
→ 18 files passed; 181 tests passed
→ adapter/immutability/redaction/bounds/traversal
→ manifest/dedupe/single-flight/failure/reconciliation
→ WorkerManager import/reconcile lifecycle
→ native Pi writer/context isolation
→ IPC/UI/open semantics and protected Codex reader

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

pnpm exec biome check <33 changed TS/TSX/JS/MJS files>
→ passed; no diagnostics

git diff --check
→ passed
```

### Worker artifact and real Electron probe

```text
NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; 92.9 MiB / 97,375,360 B worker-only artifact
→ Pi SDK 0.84.3; permission system 27.0.1

node scripts/run-t34-legacy-import-probe.mjs out-agent-host/worker.js
→ ok=true
→ sourceImmutable=true
→ importedHistory=true
→ continuedInPi=true
→ workerPids=[66943,66964]
→ orphanWorkerPids=[]
```

真实 probe 执行：创建 Claude JSONL fixture → Main adapter/import service → import utility worker生成/校验/发布Pi v3 file → complete index/manifest → exact-file normal WorkerSlot open并验证 imported user/assistant/display-only history → 本地probe provider继续一个Pi turn → dispose全部worker并确认PID消失。

## Deferred by roadmap authority

- Codex本地import adapter等待真实 rollout 路径/格式/样本，不属于本次T34 closure。
- T35执行最终Pi-only absence audit，继续保护静态隔离的migration readers/evidence。
- 真账号queue GUI复点和高资源packaged preview/PDF/Monaco/local-file smoke仍由T37关闭。
