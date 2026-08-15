import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_MANAGED_CONFIG_ENV_KEY,
  CODEX_MANAGED_CONFIG_POSTURE,
  CODEX_MANAGED_CONFIG_PROVIDER_ID,
  generateManagedCodexConfigToml,
} from '../codexManagedConfig';

const BLESSED_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'main',
  'services',
  'auth',
  '__tests__',
  'fixtures',
  'codex-config.blessed.toml'
);
/** Must match `README.md` next to the fixture — the exact input the blessing spike ran with. */
const BLESSED_BASE_URL = 'https://cch-blessing.example.com/v1';

describe('generateManagedCodexConfigToml (D47 S3b §3)', () => {
  it('produces exactly the root three keys + [model_providers.jyw] five keys, no model / no context keys', () => {
    const toml = generateManagedCodexConfigToml({ baseUrl: 'https://example.test/v1' });

    expect(toml).toBe(
      [
        'model_provider = "jyw"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        '',
        '[model_providers.jyw]',
        'name = "jyw"',
        'base_url = "https://example.test/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'env_key = "AICLIENT_CODEX_API_KEY"',
        '',
      ].join('\n')
    );

    // Full-text scan (D47 S34 spec §4 mutation ④): neither context key is
    // written anywhere in the output, and there is no `model =` root
    // assignment (the provider table's own `name`/`base_url`/etc. keys don't
    // collide with the bare word "model").
    expect(toml).not.toMatch(/model_context_window/);
    expect(toml).not.toMatch(/model_auto_compact_token_limit/);
    expect(toml).not.toMatch(/^model\s*=/m);
  });

  it('is deterministic for the same input (no clock/env/fs)', () => {
    const a = generateManagedCodexConfigToml({ baseUrl: 'https://a.test/v1' });
    const b = generateManagedCodexConfigToml({ baseUrl: 'https://a.test/v1' });
    expect(a).toBe(b);
  });

  it('escapes a baseUrl containing a quote/backslash into a valid TOML basic string', () => {
    const toml = generateManagedCodexConfigToml({ baseUrl: 'https://evil.test/"; x = 1 #\\' });
    expect(toml).toContain(`base_url = ${JSON.stringify('https://evil.test/"; x = 1 #\\')}`);
  });

  it('always names the provider table/env_key the same, matching the exported constants', () => {
    const toml = generateManagedCodexConfigToml({ baseUrl: 'https://example.test/v1' });
    expect(toml).toContain(`[model_providers.${CODEX_MANAGED_CONFIG_PROVIDER_ID}]`);
    expect(toml).toContain(`env_key = "${CODEX_MANAGED_CONFIG_ENV_KEY}"`);
  });
});

describe('CODEX_MANAGED_CONFIG_POSTURE same-source assertion (D47 S34 spec §3)', () => {
  // Cross-tsconfig import is not viable: `src/agent-host` imports its own
  // siblings with explicit `.ts` extensions (Node `--experimental-strip-types`
  // requires that), which only `src/agent-host/tsconfig.json`
  // (`allowImportingTsExtensions: true`) accepts — the root gate does not, and
  // `tsc --noEmit`'s `exclude` does NOT stop it from pulling in a file that is
  // explicitly imported from an included file. [实测]: `tsc --noEmit` against a
  // one-line `import { CODEX_PERMISSION_DEFAULT } from
  // '.../codexRuntime.ts'` produces `TS5097: An import path can only end with
  // a '.ts' extension when 'allowImportingTsExtensions' is enabled` across the
  // whole agent-host import graph. So this pins the SOURCE TEXT instead — same
  // pattern as `src/main/services/agent-host/__tests__/hostEnv.test.ts`'s
  // `readFileSync(...).toContain(...)` checks.
  const codexRuntimeSource = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'agent-host', 'codexRuntime.ts'),
    'utf8'
  );

  it('has the same approvalPolicy as agent-host CODEX_PERMISSION_DEFAULT', () => {
    expect(codexRuntimeSource).toContain("approvalPolicy: 'on-request',");
    expect(CODEX_MANAGED_CONFIG_POSTURE.approvalPolicy).toBe('on-request');
  });

  it('has the same sandboxMode as agent-host CODEX_PERMISSION_DEFAULT', () => {
    expect(codexRuntimeSource).toContain("sandboxMode: 'workspace-write',");
    expect(CODEX_MANAGED_CONFIG_POSTURE.sandboxMode).toBe('workspace-write');
  });

  it('generateManagedCodexConfigToml writes the exact same posture values into config.toml', () => {
    const toml = generateManagedCodexConfigToml({ baseUrl: 'https://example.test/v1' });
    expect(toml).toContain(`approval_policy = "${CODEX_MANAGED_CONFIG_POSTURE.approvalPolicy}"`);
    expect(toml).toContain(`sandbox_mode = "${CODEX_MANAGED_CONFIG_POSTURE.sandboxMode}"`);
  });
});

describe('blessed fixture (D47 S3b §3 strict-config blessing spike)', () => {
  it('matches the generator output byte-for-byte (hermetic — see fixtures/README.md for the real codex --strict-config run)', () => {
    const blessed = readFileSync(BLESSED_FIXTURE_PATH, 'utf-8');
    const generated = generateManagedCodexConfigToml({ baseUrl: BLESSED_BASE_URL });
    expect(generated).toBe(blessed);
  });
});
