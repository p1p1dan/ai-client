import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentHostEnv } from '../hostEnv';

const INPUT = {
  driver: 'agent-sdk',
  cometixVersion: '2.1.112',
  nodeExecPath: '/opt/app/resources/node-runtime/node',
  appVersion: '0.4.0-test.2',
  codexHomeDir: '/home/u/.config/AiClient/codex-home',
} as const;

describe('buildAgentHostEnv', () => {
  it('passes every Main-owned value through unchanged', () => {
    expect(buildAgentHostEnv({ ...INPUT })).toEqual({
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
    expect(Object.keys(buildAgentHostEnv({ ...INPUT }))).not.toContain('AICLIENT_AGENT_CODEX');
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
