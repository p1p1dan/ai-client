import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-3b static guards (SG-01, SG-03).
 *
 * The supervisor is the one Main component allowed to signal the shared DSH
 * host, and it may only ever do it one way: `child.kill('SIGKILL')` on the
 * ChildProcess it spawned. `process.kill` with a computed pid, a negative
 * (process-group) pid, or a detached spawn is how the kill(-1) incident took a
 * whole desktop session down. Comments are stripped: the files explain the ban
 * by naming it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HOST = path.resolve(HERE, '..');
const REPO = path.resolve(HERE, '../../../../..');

function code(name: string): string {
  const file = path.join(AGENT_HOST, name);
  return stripComments(readFileSync(file, 'utf8'), file);
}

describe('shared DSH host signalling (SG-01)', () => {
  it('the supervisor signals only through child.kill(SIGKILL)', () => {
    const source = code('DshHostSupervisor.ts');
    expect(source).not.toContain('process.kill');
    expect(source).not.toMatch(/kill\(\s*-/);
    expect(source).not.toMatch(/detached/);
    expect(source.match(/\.kill\(/g)).toEqual(['.kill(']);
    expect(source).toContain("child.kill('SIGKILL')");
  });

  it('a channel never signals anything; the launch options never detach', () => {
    const channel = code('DshChannelTransport.ts');
    expect(channel).not.toContain('process.kill');
    expect(channel).not.toMatch(/\.kill\(/);
    const launch = code('DshHostProcess.ts');
    expect(launch).not.toContain('process.kill');
    expect(launch).not.toMatch(/detached/);
  });
});

describe('host environment rule (SG-03)', () => {
  const pinned = '/KEY|PASSWORD|SECRET|TOKEN/i';
  const ours = code('DshHostProcess.ts').match(
    /export const DSH_SENSITIVE_ENV_PATTERN = (\/[^\n]+\/[a-z]*);/
  )?.[1];

  it('keeps the credential-name rule literal unchanged', () => {
    expect(ours).toBe(pinned);
  });

  // Runs wherever the pinned DSH package is installed (`npm ci` in src/dsh-host):
  // a DSH upgrade that changes the rule fails here (decision 003's upgrade check).
  const dsh = path.join(REPO, 'src/dsh-host/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js');
  it.skipIf(!existsSync(dsh))('matches the rule DSH applies to tool environments', () => {
    const theirs = readFileSync(dsh, 'utf8').match(
      /const SENSITIVE_ENV_PATTERN = (\/[^\n]+\/[a-z]*);/
    )?.[1];
    expect(theirs).toBe(ours);
  });
});
