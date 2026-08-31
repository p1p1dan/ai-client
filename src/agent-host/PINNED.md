# Pi Worker — dependency pins

## Shipped production dependencies

| Package | Version | Role |
|---|---:|---|
| `@earendil-works/pi-coding-agent` | **0.84.3** | one Pi AgentSession per utility worker |
| `@gotgenes/pi-permission-system` | **27.0.1** | fail-closed tool permission extension |

Both are exact pins in `package.json` / `package-lock.json`. The worker artifact verifier requires the Pi SDK entry, permission extension entry, WASM grammar, policy, and license notices. A bump must rerun:

```text
pnpm typecheck:agent-host
pnpm build:agent-host
pnpm smoke:permission-plugin
node scripts/run-t29c-worker-probe.mjs out-agent-host/worker.js
```

## Legacy test-only dependencies

The following exact versions remain **devDependencies only** while their isolated Claude/Codex source tests still exist:

| Package | Version |
|---|---:|
| `@anthropic-ai/claude-agent-sdk` | **0.3.218** |
| `@cometix/claude-code` | **2.1.212** |
| `@openai/codex` | **0.149.1** |

Packaging jobs install with `npm ci --omit=dev --omit=optional`; `scripts/agent-host-build-lib.mjs` and packaged verification independently reject these execution packages. They are not worker runtime dependencies or shipped payload. Their historical pin rationale remains in Git history and the superseded multi-agent planning evidence until T31/T35 deletes the remaining execution source/tests.
