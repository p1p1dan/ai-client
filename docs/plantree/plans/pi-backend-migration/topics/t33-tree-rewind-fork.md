# Topic — T33 session tree, rewind and fork contract

Role: implementation contract
Status: accepted / landed
Phase: D / T33
Authority: [roadmap](../roadmap.md)、[D15](../decisions/015-main-owned-worker-manager.md)、[timeline reference](./timeline-reference.md)
Related: [T32 evidence](../evidence/2026-09-01-t32-history-real-resume.md)、[T33 evidence](../evidence/2026-09-01-t33-tree-rewind-fork.md)、[reference repositories](./reference-repositories.md)

## Scope

T33在T32 exact-file resume与active-branch timeline基础上增加三项Pi-native能力：

1. bounded iterative session tree；
2. idle-only、明确确认的branch rewind；
3. 从exact Pi entry创建独立application session/file/WorkerSlot的fork。

硬验收保持：A→B→C，回退到A后发D，B/C与D两分支均可浏览；从A fork后源/新会话独立继续。

## Fixed contracts

- Pi SDK、SessionManager tree/branch/fork调用只存在于所属utility worker；Main/renderer不解析或写Pi JSONL。
- tree worker上限4000节点，renderer展示上限320节点；迭代构建，不采用无上限递归。
- tree response同时绑定logical session、normalized session-file authority、WorkerSlot generation和renderer request sequence；session切换、更新请求或slot replacement后的迟到成功/错误均丢弃。
- rewind调用Pi `AgentSession.navigateTree(..., { summarize: false })`；Main和worker都重检idle/无blocking Extension UI/明确确认。
- rewind不截断JSONL；active branch replacement不能走T32 same-branch replay merge，renderer必须用独立branch-replace语义移除当前视图中的旧分支消息。
- active leaf作为session index可选字段持久化并在exact-file reopen/crash restart时重放；新物理tail出现后旧leaf checkpoint失效，避免发送D后又跳回A。
- fork在source worker中用单独打开的SessionManager创建branched file；禁止调用会替换source runtime的same-slot fork/remap路径。
- fork transaction顺序：capacity reservation → staged file → independent provisional WorkerSlot exact-open → atomic complete index row → publish。commit前失败清理provisional slot与本事务创建的staged file；源session不变。
- 只有真实Pi `entryId`可触发rewind/fork；runtime message id、turn id和renderer合成id不能代替。

## Reference disposition

基线：pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）。本切片按行为与场景适配实现；若后续复制substantial source/test block，必须补distributed MIT notice。

### Direct behavior / scenario

- iterative map/link/stack flatten、orphan-as-root、backend/UI node caps；
- session key + monotonic request sequence stale guard；
- Pi native navigate/tree/fork场景；
- active leaf override在reopen时重放；
- A/B/C→rewind→D分支保留与source/fork isolation tests。

### Adapted

- tree读取放入本仓WorkerSlot，不采用Main preview process；
- rewind增加明确AlertDialog确认、Main+worker idle gate和renderer transient reset；
- leaf authority接本仓SessionIndexService、crash restart与exact-file identity；
- fork创建独立logical session、index row和WorkerSlot，不remap source slot；
- UI使用本仓@coss/ui、session bucket与history entry-id contract。

### Rejected

- Main/renderer直接解析Pi JSONL；
- uncapped recursive `getTree()` projection；
- double-click或无确认rewind；
- JSONL truncate或renderer数组裁剪伪装rewind；
- same-slot fork/remap、foreground worker fallback或第二套supervisor；
- fixed sleep替代flush/dispose/materialization确认。

## Verification matrix

- worker/shared：tree cap/orphan/depth/leaf、rewind busy+confirm+branch preservation、separate-manager fork/source unchanged、RPC guards。
- Main/index/IPC：generation/revision stale guard、leaf atomic persistence/rollback、fork complete-row atomic commit/capacity/cleanup、path不由renderer提供。
- renderer：entryId preservation、branch replacement、targeted transient reset、request sequence/session key guard、320-node cap、confirm-only mutation与fork selection。
- real Electron utilityProcess：A→B→C→rewind A→D两臂可浏览；A fork后源/新会话独立stream；restart保持正确leaf；app close无orphan。
- 资源约束：focused Vitest小批串行、两套typecheck、scoped Biome、worker-only build；不运行full Vitest或整套production build。
