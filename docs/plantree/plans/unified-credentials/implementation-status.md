# Implementation Status — Unified Credentials and App State

**Status**：Completed; no active implementation handoff.

**Last Verified**：2026-08-28 — S0′/S1/S2/S3/S4 已落地；Pi vault arm 与 managed model/auth chain 已由 Pi migration Phase 5 验证。

**Last Landed**：`~/.pilab/<profile>/` app-state layout、vault/profile migration、runtime credential mode、Main-owned settings keys、可选 Pi credential arm。

## Preserved risks

- safeStorage 在无 keyring Linux 上不应被视为强安全边界；
- source/user config parsing errors 必须带可操作诊断；
- renderer 不得覆盖 `credentialMode` 等 Main-owned settings keys；
- legacy credentials 在 Pi-only cleanup 中只能保留 migration/adoption 所需最小面。

## Handoff

活动工作已转到：

- [Pi roadmap T28–T37](../pi-backend-migration/roadmap.md)；
- [D14 legacy import](../pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md)；
- [D15 WorkerManager](../pi-backend-migration/decisions/015-main-owned-worker-manager.md)。

重排前详细风险、commit 和本机环境说明见 [history snapshot](./history/2026-08-31-pre-pi-only-realignment/implementation-status.md)。
