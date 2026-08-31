# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase A / T28 complete；进入 Phase B / T29 single WorkerSlot vertical slice。

**Next Target**：[T29](./roadmap.md#t29--single-workerslot-vertical-slice--next) `newSession → send → stream → stop → dispose`，不依赖旧 `PiHostProcess`。

**Last Landed**：2026-08-31 Phase A 文件级 replacement/deletion baseline；见 [T28 map](./topics/t28-replacement-map.md) 与 [evidence](./evidence/2026-08-31-phase-a-t28.md)。

**Last Verified**：2026-08-31 — replacement map path/link audit、changed-file scope audit、`git diff --check`；Phase A 未修改 product code，未运行不必要的 full Vitest/build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 最终删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [T28 map](./topics/t28-replacement-map.md) 是 T29/T34/T35/T36 的文件级删除/保护 authority；按文件名机械删除被禁止。

## Phase A done

- `AgentHostManager`/`PiHostProcess`/standalone Host、worker modules、contracts、IPC/preload、renderer semantics、services、credentials、terminal、packaging、tests/spikes 已分类。
- Cycle 1/2 queue/pending/timeline/Extension UI/model/permission behavior 已标记 retain/adapt，并要求 slot generation isolation。
- Claude/Codex history readers 与 Claude scanner 已标记 migration-only；execution imports 被禁止。
- Codex ASR production implementation 未找到；method fixture 不构成保留 Codex dependency 的证据。
- pi-app/pix 对应 source/tests 已读，并登记 direct candidate / adapt / reject 与 MIT notice 规则。

## Active TODO

1. **T29-a**：落 Worker RPC、request ID、timeout、generation、dispose/crash contract。
2. **T29-b**：落一个 utility worker + one Pi AgentSession bootstrap，接 managed agentDir/auth/models/project trust/permission。
3. **T29-c**：完成 `newSession → send → stream → stop → dispose` focused tests 与 orphan census。
4. **T30 ready-check**：T29 通过后再收口 pool capacity/remap/eviction/restart。
5. **并行环境欠项**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file smoke（T37 前关闭）。

## Blocked By / risks

- T29 无产品决策 blocker；Q12 pool 默认容量不阻塞单 slot。
- 当前 3.3 GiB 主机继续按根 `AGENTS.md` 小批串行测试，禁止 full build/full Vitest。
- T35 deletion 仍被 T34 read-only adapter isolation 和 T29–T33 replacement 闭环阻塞。
- T36 必须证明 bundled absolute Pi CLI path 与 GUI/TUI single-writer。

## Handoff

1. 先读 [T28 runtime/contracts map](./topics/t28-replacement-map/runtime-and-contracts.md) 与 [tests/reference map](./topics/t28-replacement-map/packaging-tests-and-references.md)。
2. T29 从 pi-app WorkerSlot/transport/session-isolation tests 移植主体，适配本仓 RuntimeEvent/owner/permission；substantial copying 保留 MIT notice。
3. 第一切片只做单 slot，不焊 pool/history/import/TUI 到旧 singleton。
4. stop/dispose 不用固定 sleep 代替明确 ACK/terminal contract；完成后检查无 orphan utilityProcess。
