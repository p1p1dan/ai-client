# Agent Host — pinned dependencies (Phase 0)

| Package | Version | Evidence |
|---|---|---|
| `@cometix/claude-code` | **2.1.212** | npm tarball SHA256 `85c43e15b6ad0a28f7df833724262b100098db76a27c50b212c9e75b6d3ca404` |
| `@anthropic-ai/claude-agent-sdk` | **0.3.218** | Phase 0 dual-path spike |
| `@openai/codex` | **0.145.0** | Intersection of fixture-capture version (`src/agent-host/__tests__/fixtures/codex/README.md`) and blessing-record version (`src/main/services/auth/__tests__/fixtures/README.md:41`) — see `docs/plans/2026-08-19-stage4-packaging-spec.md` §3.1 |

Do not bump `@openai/codex` without following the upgrade rule in the packaging spec §3.1 (re-run blessing, re-diff the contract snapshot, re-audit fixture shape assumptions).

## Cometix tarball

- URL: https://registry.npmjs.org/@cometix/claude-code/-/claude-code-2.1.212.tgz
- npm integrity (sha512): `sha512-zpv9fTlhNwmrn4JC96U4kfJrFE7rxwsjzPb359QleS0J65/OFpdHlJUvlrfbCOD8f0npep4t1G6s6KShN5sFEg==`
- npm shasum (sha1): `948d4092310a4a6c0d9b95c3c96127bb1e75c6b2`

Do not bump without re-running spikes and updating `docs/plans/phase0-report.md`.
