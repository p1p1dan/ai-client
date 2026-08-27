import { describe, expect, it } from 'vitest';
import { CODEX_MANAGED_API_KEY_ENV } from '../agentSupport.ts';
import { buildCodexConfigOverrides, CODEX_MANAGED_PROVIDER_ID } from '../codexConfigOverrides.ts';

/**
 * S0' codex side (D60). These pin the argv that REPLACED a generated
 * `config.toml`, so the assertions are written as the spawn line a reader could
 * paste into a shell — expected values are literals, never rebuilt from the
 * same expression the implementation uses.
 */
describe('codex -c overrides', () => {
  const POSTURE = { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' };

  /** Turns the flat argv back into `key=value` strings, so a test can talk about entries. */
  function entriesOf(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i += 2) {
      expect(argv[i]).toBe('-c');
      out.push(argv[i + 1]);
    }
    return out;
  }

  it('emits the full provider table plus the posture in managed mode', () => {
    expect(
      buildCodexConfigOverrides({
        posture: POSTURE,
        provider: { baseUrl: 'https://gateway.example.com/v1' },
      })
    ).toEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'model_provider="jyw"',
      '-c',
      'model_providers.jyw.name="jyw"',
      '-c',
      'model_providers.jyw.base_url="https://gateway.example.com/v1"',
      '-c',
      'model_providers.jyw.wire_api="responses"',
      '-c',
      'model_providers.jyw.requires_openai_auth=false',
      '-c',
      'model_providers.jyw.env_key="AICLIENT_CODEX_API_KEY"',
    ]);
  });

  /**
   * Fallback means "we are not supplying the credential". It has never meant
   * "the user's `danger-full-access` is in force" — E1 R5 measured `-c` beating
   * exactly that, and this is the assertion that keeps the posture on the
   * unconditional side of the branch.
   */
  it('still forces the posture when no credential is supplied', () => {
    expect(buildCodexConfigOverrides({ posture: POSTURE, provider: null })).toEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
    ]);
  });

  it('carries the session posture, not a constant', () => {
    const entries = entriesOf(
      buildCodexConfigOverrides({
        posture: { approvalPolicy: 'never', sandboxMode: 'read-only' },
        provider: null,
      })
    );
    expect(entries).toEqual(['approval_policy="never"', 'sandbox_mode="read-only"']);
  });

  /**
   * The key NAME travels in the override; the key VALUE travels in the env.
   * That indirection is the whole reason nothing secret is ever on this argv —
   * and an argv is visible to every process on the machine via `ps`.
   */
  it('names the credential env var but never carries a credential', () => {
    const argv = buildCodexConfigOverrides({
      posture: POSTURE,
      provider: { baseUrl: 'https://gateway.example.com/v1' },
    });
    expect(argv).toContain(
      `model_providers.${CODEX_MANAGED_PROVIDER_ID}.env_key="${CODEX_MANAGED_API_KEY_ENV}"`
    );
    expect(argv.join(' ')).not.toMatch(/sk-|api[_-]?key=/i);
  });

  /** `requires_openai_auth` must be a TOML boolean. `"false"` is a non-empty STRING, which is truthy. */
  it('emits requires_openai_auth as a bare boolean, not a quoted string', () => {
    const entries = entriesOf(
      buildCodexConfigOverrides({ posture: POSTURE, provider: { baseUrl: 'https://x/v1' } })
    );
    expect(entries).toContain('model_providers.jyw.requires_openai_auth=false');
    expect(entries).not.toContain('model_providers.jyw.requires_openai_auth="false"');
  });

  /** A base URL with a quote in it must not be able to close the TOML string and inject a second key. */
  it('escapes a base URL that tries to break out of the TOML string', () => {
    const entries = entriesOf(
      buildCodexConfigOverrides({
        posture: POSTURE,
        provider: { baseUrl: 'https://evil/"\napproval_policy = "never' },
      })
    );
    const baseUrlEntry = entries.find((e) => e.startsWith('model_providers.jyw.base_url='));
    expect(baseUrlEntry).toBe(
      'model_providers.jyw.base_url="https://evil/\\"\\napproval_policy = \\"never"'
    );
  });

  it('produces a well-formed flag/value argv with no odd tail', () => {
    const argv = buildCodexConfigOverrides({
      posture: POSTURE,
      provider: { baseUrl: 'https://x/v1' },
    });
    expect(argv.length % 2).toBe(0);
    expect(argv.filter((a) => a === '-c')).toHaveLength(argv.length / 2);
  });
});
