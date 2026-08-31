# Risk Hotspots

| 风险 | 必须保持的不变量 | 清零/验证路径 |
|---|---|---|
| Slot identity/remap | temporary workspace key → session file 原子 remap；不能双 authority | T29/T30 remap failure/duplicate create tests |
| Cross-session leakage | 所有 event/response 带 session + runtime + generation；owner route 单一 | multi-slot/session-switch/late-event tests |
| UtilityProcess orphan | stop/crash/app close 后无残留 worker | disposeAll、process census、packaged close smoke |
| Pool OOM/resource churn | bounded capacity；active/pending slot 不淘汰；安全 capacity error | low-capacity tests、idle reclaim、长时 RAM/swap 观察 |
| Worker crash/restart loop | 单 slot failure 隔离；restart 有界；旧 generation 丢弃 | crash injection、restart budget、other-slot continuity |
| Extension UI stranded request | crash/reload/rewind/retire 必须 cancel/reset | blocking/display lifecycle tests + GUI smoke |
| Pi session corruption | Main/renderer 不直接写 JSONL；rewind/fork 用 Pi native APIs | incomplete/corrupt fixtures、branch hard acceptance |
| Legacy source mutation | import source hash 前后相同；temporary target atomic publish | read-only adapters、failure injection、dedupe tests |
| Import semantic overclaim | 只承诺历史继续，不恢复 hidden runtime state | provenance、unmapped tool read-only UI、copy wording review |
| GUI/TUI double writer | 同 durable session 只有一个 write authority | exclusivity guard、flush/open ACK、crash/return tests |
| Pi CLI/resources packaging | external bundled Node 能解析 Resources，不能假设 root asar 可读 | afterPack/verifier、platform packaged smoke |
| Permission bypass | plugin/gate fail closed；managed/local project trust 明确 | resolver matrix、bundled smoke、four-decision GUI |
| Managed credential/config leak | key 不进 models.json/argv/log；Main-owned settings key 不被 renderer 覆盖 | redaction tests、settings ownership tests、packaged logs |
| Reference code license | substantial copying 保留 MIT notice | T28–T37 reuse ledger + release license audit |
| Dirty shared worktree | 不覆盖并发 Cycle 1/2 未提交改动 | scoped edits、status/diff audit、no broad formatter writes |

## Current host resource constraint

开发机约 3.3 GiB RAM。完整 Vitest、全量 build、Electron Builder、Agent Host packaging 必须串行且按根 `AGENTS.md` 拆分；无法安全运行的 packaged gate留给 CI/高资源主机，不能用反复重试制造 swap/OOM。
