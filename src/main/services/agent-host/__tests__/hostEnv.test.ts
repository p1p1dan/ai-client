import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentHostEnv, deriveBundledCodexJsPath } from '../hostEnv';

const INPUT = {
  driver: 'agent-sdk',
  cometixVersion: '2.1.112',
  nodeExecPath: '/opt/app/resources/node-runtime/node',
  appVersion: '0.4.0-test.2',
  codexHomeDir: '/home/u/.config/AiClient/codex-home',
} as const;

// D47 S3b §1 — the three Codex managed-credentials keys. Every INPUT literal
// above this line is deliberately left WITHOUT them so the pre-existing
// five-key `toEqual` test below (unmodified since before S3b) still passes:
// `toEqual` ignores `undefined`-valued object properties, and `buildAgentHostEnv`
// must still emit these three keys with value `undefined` when the caller
// doesn't pass them — which is exactly what "flag off" looks like.
const CODEX_MANAGED_INPUT = {
  codexManaged: '1',
  codexApiKey: 'sk-managed-test-key',
  codexHomeManagedDir: '/home/u/.config/AiClient/codex-home',
} as const;
const CODEX_UNMANAGED_INPUT = {
  codexManaged: undefined,
  codexApiKey: undefined,
  codexHomeManagedDir: undefined,
} as const;

describe('buildAgentHostEnv', () => {
  it('passes every Main-owned value through unchanged (pre-S3b five keys, unmodified since before D47 S3b — undefined-valued new keys are invisible to toEqual)', () => {
    expect(buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT })).toEqual({
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
      AICLIENT_COMETIX_VERSION: '2.1.112',
      AICLIENT_NODE_EXEC_PATH: '/opt/app/resources/node-runtime/node',
      AICLIENT_APP_VERSION: '0.4.0-test.2',
      AICLIENT_CODEX_HOME: '/home/u/.config/AiClient/codex-home',
    });
  });

  it('does not inject the Codex feature flag', () => {
    // AgentHostProcess.start() spreads process.env into the child, so the flag
    // already reaches the Host. Injecting it here would create a second place
    // that decides what the flag means. Falsifies: "add it for symmetry".
    expect(Object.keys(buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT }))).not.toContain(
      'AICLIENT_AGENT_CODEX'
    );
  });
});

describe('buildAgentHostEnv — Codex managed-credentials three keys (D47 S34 spec rev.2 §1, A-track B3)', () => {
  it('managed on: emits the marker + api key + managed dir verbatim', () => {
    expect(buildAgentHostEnv({ ...INPUT, ...CODEX_MANAGED_INPUT })).toEqual({
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
      AICLIENT_COMETIX_VERSION: '2.1.112',
      AICLIENT_NODE_EXEC_PATH: '/opt/app/resources/node-runtime/node',
      AICLIENT_APP_VERSION: '0.4.0-test.2',
      AICLIENT_CODEX_HOME: '/home/u/.config/AiClient/codex-home',
      AICLIENT_CODEX_MANAGED: '1',
      AICLIENT_CODEX_API_KEY: 'sk-managed-test-key',
      AICLIENT_CODEX_HOME_MANAGED_DIR: '/home/u/.config/AiClient/codex-home',
    });
  });

  it('managed on but vault has no usable key yet: marker + dir present, key undefined (agent-host resolver reads this as managed_missing_credentials, not this file)', () => {
    const result = buildAgentHostEnv({
      ...INPUT,
      codexManaged: '1',
      codexApiKey: undefined,
      codexHomeManagedDir: '/home/u/.config/AiClient/codex-home',
    });
    expect(result.AICLIENT_CODEX_MANAGED).toBe('1');
    expect(result.AICLIENT_CODEX_HOME_MANAGED_DIR).toBe('/home/u/.config/AiClient/codex-home');
    expect(result.AICLIENT_CODEX_API_KEY).toBeUndefined();
  });

  it('flag-off arm = all three keys undefined (not merely absent)', () => {
    const result = buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT });
    expect(result.AICLIENT_CODEX_MANAGED).toBeUndefined();
    expect(result.AICLIENT_CODEX_API_KEY).toBeUndefined();
    expect(result.AICLIENT_CODEX_HOME_MANAGED_DIR).toBeUndefined();
  });

  it('continuation-pollution defense: the three keys are OWN PROPERTIES of the returned object even when undefined, not simply omitted — this is what lets a `{...process.env, ...buildAgentHostEnv(...)}` spread (AgentHostProcess.start()) OVERRIDE a stray shell/dev-inherited value instead of leaving it untouched (D47 S34 spec rev.2 §1 "继承污染防御"). Matrix: preset the OPPOSITE (inherited-looking) value on each key before asserting.', () => {
    const pollutedLikeInherited = {
      AICLIENT_CODEX_MANAGED: '1',
      AICLIENT_CODEX_API_KEY: 'sk-stray-inherited-value',
      AICLIENT_CODEX_HOME_MANAGED_DIR: '/some/stray/inherited/dir',
    };
    const result = buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT });

    // The three keys must be present as OWN properties (proving a spread of
    // `result` over `pollutedLikeInherited` would overwrite every one of
    // them to `undefined`, not skip past them).
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([
        'AICLIENT_CODEX_MANAGED',
        'AICLIENT_CODEX_API_KEY',
        'AICLIENT_CODEX_HOME_MANAGED_DIR',
      ])
    );
    expect('AICLIENT_CODEX_MANAGED' in result).toBe(true);
    expect('AICLIENT_CODEX_API_KEY' in result).toBe(true);
    expect('AICLIENT_CODEX_HOME_MANAGED_DIR' in result).toBe(true);

    // The actual override behavior `AgentHostProcess.start()` relies on:
    // spreading `result` LAST over a stand-in for "inherited env" kills every
    // stray value.
    const merged = { ...pollutedLikeInherited, ...result };
    expect(merged.AICLIENT_CODEX_MANAGED).toBeUndefined();
    expect(merged.AICLIENT_CODEX_API_KEY).toBeUndefined();
    expect(merged.AICLIENT_CODEX_HOME_MANAGED_DIR).toBeUndefined();
  });
});

describe('the Host env contract is wired to the resolver, not to a literal', () => {
  // The Host trusts AICLIENT_NODE_EXEC_PATH to be the Node 24 binary that
  // resolveNode24Runtime picked, but that invariant is maintained in another
  // file. Reading the call site keeps the two halves pinned together: without
  // this, someone could pass process.execPath (Electron, not Node 24) and every
  // test here would still pass.
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'AgentHostManager.ts'),
    'utf8'
  );

  it('AgentHostManager feeds buildAgentHostEnv the resolved runtime path', () => {
    expect(source).toContain('buildAgentHostEnv({');
    expect(source).toContain('nodeExecPath: resolved.runtime.execPath');
  });

  it('spawns the Host with that same resolved path', () => {
    // Same value on both sides is what makes process.execPath inside the Host a
    // valid fallback for the env key.
    expect(source).toContain('nodeExecPath: resolved.runtime.execPath,');
  });

  it('no longer builds the env as an inline literal', () => {
    // Falsifies a partial revert that keeps buildAgentHostEnv but re-adds the
    // old two-key object next to it.
    expect(source).not.toContain('AICLIENT_AGENT_HOST_DRIVER: this.driver');
  });
});

/**
 * Packaging spec §7.2 B1 / B2 / B3 — the bundled Codex path derivation and the
 * conditional `AICLIENT_CODEX_JS_PATH` key.
 */
describe('deriveBundledCodexJsPath (B1, B2)', () => {
  it('puts node_modules next to the packaged Host entry', () => {
    expect(deriveBundledCodexJsPath('/opt/app/resources/agent-host/index.js')).toBe(
      '/opt/app/resources/agent-host/node_modules/@openai/codex/bin/codex.js'
    );
  });

  it('puts node_modules next to the dev Host entry', () => {
    // Dev shape: the sibling node_modules is src/agent-host/node_modules, which
    // is why this derives from the entry path instead of process.resourcesPath.
    expect(deriveBundledCodexJsPath('/repo/src/agent-host/index.ts')).toBe(
      '/repo/src/agent-host/node_modules/@openai/codex/bin/codex.js'
    );
  });

  it('always lands on the Node-executable codex.js (REQ-8)', () => {
    for (const entry of [
      '/opt/app/resources/agent-host/index.js',
      '/repo/src/agent-host/index.ts',
      'C:\\Program Files\\AiClient\\resources\\agent-host\\index.js',
    ]) {
      expect(path.basename(deriveBundledCodexJsPath(entry))).toBe('codex.js');
    }
  });
});

describe('buildAgentHostEnv — codexJsPath is conditional (B3)', () => {
  it('emits the key when a path is supplied', () => {
    const env = buildAgentHostEnv({
      ...INPUT,
      ...CODEX_UNMANAGED_INPUT,
      codexJsPath: '/opt/app/resources/agent-host/node_modules/@openai/codex/bin/codex.js',
    });
    expect(env.AICLIENT_CODEX_JS_PATH).toBe(
      '/opt/app/resources/agent-host/node_modules/@openai/codex/bin/codex.js'
    );
  });

  it('omits the key entirely when undefined — NOT present-with-undefined', () => {
    // Object.keys, never toEqual: toEqual ignores undefined-valued properties,
    // so the "key always present, value undefined" mutation (M6) would sail
    // straight through a toEqual assertion. That mutation matters because an
    // own property with value undefined OVERRIDES the inherited process.env
    // value in AgentHostProcess.start(), slamming the user's escape hatch shut.
    const keys = Object.keys(
      buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT, codexJsPath: undefined })
    );
    expect(keys).not.toContain('AICLIENT_CODEX_JS_PATH');
  });

  it('omits the key when it is not passed at all', () => {
    const keys = Object.keys(buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT }));
    expect(keys).not.toContain('AICLIENT_CODEX_JS_PATH');
  });

  it('contrasts with the D47 trio, which stays present-with-undefined', () => {
    // The asymmetry is the design (see hostEnv.ts header): credentials must
    // override inherited env, a path must not.
    const keys = Object.keys(buildAgentHostEnv({ ...INPUT, ...CODEX_UNMANAGED_INPUT }));
    expect(keys).toContain('AICLIENT_CODEX_MANAGED');
    expect(keys).toContain('AICLIENT_CODEX_API_KEY');
    expect(keys).toContain('AICLIENT_CODEX_HOME_MANAGED_DIR');
  });
});
