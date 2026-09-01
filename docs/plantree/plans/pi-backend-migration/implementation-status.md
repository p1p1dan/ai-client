# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase E / T34 read-only Claude/Codex conversation import；T33 Pi-native tree, rewind and fork已完成。

**Next Target**：[T34](./roadmap.md#t34--read-only-claudecodex-import-service--planned) 定义`ImportedConversation`、隔离legacy read-only adapters，并建立temporary Pi JSONL → validate → atomic publish → dedupe/provenance transaction。

**Last Landed**：2026-09-01 T33-a/b/c closure：bounded iterative tree、request/session/generation/branch stale guard、confirmed idle-only native rewind、append-only branch preservation、durable leaf checkpoint/restart、separate-manager independent fork、atomic complete index row与rollback cleanup；见 [evidence](./evidence/2026-09-01-t33-tree-rewind-fork.md)。

**Last Verified**：2026-09-01 — shared/agent-host 6 files / 37 tests；Main Worker/index/IPC 4 / 64；renderer tree/timeline/history/actions/lifecycle 7 / 134；两套typecheck、35-file Biome、diff/boundary scan；92.8 MiB worker-only build；真实Electron A/B/C→rewind A→restart→D branches→fork A→source E/fork F probe，无orphan。未运行full Vitest或整套production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [T28 map](./topics/t28-replacement-map.md) 继续作为 T34/T35/T36 的文件级删除/保护 authority。

## T33 closure

- **Tree**：WorkerSlot内从已打开SessionManager迭代投影exact entry tree；backend 4000、UI 320；orphan root、active path/leaf/label/preview与stale guards闭环。
- **Rewind**：Main+worker重检idle/无blocking UI，renderer明确AlertDialog确认；Pi native navigate不截断JSONL；branch history替换与targeted transient reset不混入旧分支。
- **Leaf authority**：session index持久化active leaf + physical tail；exact reopen/crash restart只重放仍匹配的checkpoint，新append使旧checkpoint失效。
- **Fork**：source worker使用separate SessionManager生成新file；Main新建atomic index row与independent WorkerSlot，commit前失败清file/slot，source row/file/slot/leaf不变。
- **Hard acceptance**：真实utilityProcess证明A→B→C→rewind A→D两臂保留；A fork后source/new session独立并行继续且无orphan。

## Active TODO

1. **T34-a**：定义`ImportedConversation`中间模型、schema version、provenance与unmapped tool/custom只读表达。
2. **T34-b**：隔离Claude/Codex/旧index read-only adapters与static import ban；source hash/mode/mtime不变。
3. **T34-c**：temporary Pi JSONL → Pi native validate → atomic publish → complete index row；dedupe/import manifest与failure cleanup。
4. **T34-d**：scan/preview/select/import/report/open UI；准确表述“导入历史并在Pi中继续”。
5. **并行环境欠项**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file smoke（T37前关闭）。

## Blocked By / risks

- T34首版source范围仍见 [Q14](./open-questions.md#q14--legacy-import-首版-source-范围)；可按adapter逐一落地，不阻塞统一模型与transaction skeleton。
- legacy source永不修改；失败不得暴露半成品Pi session；重复导入必须可检测，无法映射tool不得重新执行。
- 当前3.3 GiB主机继续小批串行测试，禁止full build/full Vitest。
- T35 deletion仍被T34 reader isolation/import闭环阻塞；T36必须证明bundled absolute Pi CLI path与GUI/TUI single-writer。

## Handoff

1. 先读 [D14](./decisions/014-pi-only-product-and-conversation-import.md)、[T28 map](./topics/t28-replacement-map.md)、[T33 evidence](./evidence/2026-09-01-t33-tree-rewind-fork.md) 与 [storage baseline](../../baseline/storage-and-state.md)。
2. T34复用T32/T33已验证的exact-file/header/SessionManager validation与complete index transaction；不得把legacy source当runtime tree/fork。
3. source adapters只读且与Claude/Codex execution modules静态隔离；原文件不rename/move/delete/modify。
4. T34完成后按D16删除被import替代的剩余legacy history authority，再进入T35 absence audit。
