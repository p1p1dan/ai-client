# Agent Host — pinned dependencies (Phase 0)

| Package | Version | Evidence |
|---|---|---|
| `@cometix/claude-code` | **2.1.212** | npm tarball SHA256 `85c43e15b6ad0a28f7df833724262b100098db76a27c50b212c9e75b6d3ca404` |
| `@anthropic-ai/claude-agent-sdk` | **0.3.218** | Phase 0 dual-path spike |
| `@openai/codex` | **0.149.1** | Bumped 2026-08-26 (D54 ② upgrade ticket, npm `latest` at the time; the ticket named 0.147.0, which was two minors stale by the time it ran — user picked latest). Contract batch evidence below. |

Do not bump `@openai/codex` without following the upgrade rule in the packaging spec §3.1 (re-run blessing, re-diff the contract snapshot, re-audit fixture shape assumptions).

### 0.145.0 → 0.149.1 (2026-08-26) — the three-piece, as run

| 件 | 结果 |
|---|---|
| ① blessing 重跑 | **PASS** — `config.toml parse ok`, no `unknown configuration field`, `auth` ✓ `AICLIENT_CODEX_API_KEY (present)`. Generator untouched, so `codex-config.blessed.toml` is byte-identical and was not replaced. Record: `src/main/services/auth/__tests__/fixtures/README.md`. |
| ② 契约快照 diff | **纯增量，零删除**. clientRequest 126 → 150, serverNotification 70 → 75; serverRequest (11) and threadItemTypes (18) byte-identical including generated order. The only shape that moved is `ToolRequestUserInputParams`, which gained a **required** `isBlocking: boolean` (and upstream deprecated `autoResolutionMs` in favour of it). Legacy `ReviewDecision` gained `approved_mcp_policy_amendment`; `CodexErrorInfo` gained `misalignmentPolicyViolation`; `ThreadItem` gained four optional fields. Per-snapshot detail: `src/agent-host/__tests__/fixtures/codex/README.md`. |
| ③ 夹具形状复核 | `ThreadStatus` four arms and the "`idle` has no `activeFlags` key" premise (slice 5 §4.5 改判①) both still hold. The `.jsonl` transcript fixtures stay at 0.145.0 — they are real captures that cost quota and are never rewritten. |
| 承重表重测 | Entry binary linux 310,730,800 → **258,227,840** B, win32 359,245,096 → **297,481,008** B; effective payload `P` linux 363,716,282 → **322,960,682** B, win32 427,157,004 → **391,168,020** B. **codex shrank ~40 MB, so the packaging budget's LOWER bound had to move** or a correct build would have gone red as "codex not bundled" — re-baselined in `scripts/packaging-budget.mjs`. Platform-package file count (8), layout, permissions and the six-row `PLATFORM_PACKAGE_BY_TARGET` table are unchanged. |
| 真产物验证 | Local `build:agent-host` → 365,843,830 B, payload matches the derived figure to the byte. S1 `--version` = `codex-cli 0.149.1`; S2 `initialize` round-trip replies with the right `codexHome`/`platformOs` and exits clean (code 0). **Windows has not been re-verified on a runner** — its `P` is derived from the published tarball by a method that reproduces both recorded CI measurements exactly. |


## Cometix tarball

- URL: https://registry.npmjs.org/@cometix/claude-code/-/claude-code-2.1.212.tgz
- npm integrity (sha512): `sha512-zpv9fTlhNwmrn4JC96U4kfJrFE7rxwsjzPb359QleS0J65/OFpdHlJUvlrfbCOD8f0npep4t1G6s6KShN5sFEg==`
- npm shasum (sha1): `948d4092310a4a6c0d9b95c3c96127bb1e75c6b2`

Do not bump without re-running spikes and updating `docs/plans/phase0-report.md`.
