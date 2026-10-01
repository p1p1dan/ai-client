import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Approver,
  type BuiltGate,
  buildGate,
  fileCall,
  type GateOptions,
} from '../../../shared/permissions/__tests__/gateHarness.ts';
import type { PermissionGate, ToolPermissionRequest } from '../../../shared/permissions/gate.ts';
import { bashCall } from './bashHarness.ts';

/**
 * Moved from the bash permission cases of src/runtime/__tests__/tools.test.ts
 * and the "through the real shell analysis" case of
 * src/runtime/__tests__/permissionGrants.test.ts (dsh-rebase P1-12 step 2).
 *
 * Driven on the pure library with the host's tree-sitter grammar; the command
 * never runs, so a runtime assertion about its output is left out and said so.
 */

let dir: string;
const gates: PermissionGate[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-bash-tools-')));
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** A suite that does not MEAN to be asked: being asked is a loud failure. */
const neverAsked: Approver = (request) => {
  throw new Error(`unexpected permission request for ${request.tool}`);
};

/** The gate the runtime suite built with `runtime(options)`. */
async function runtime(options: GateOptions = {}): Promise<BuiltGate> {
  const built = await buildGate(dir, { approve: neverAsked, ...options });
  gates.push(built.gate);
  return built;
}

const bash = (r: BuiltGate, command: string) => bashCall(r, command, { toolCallId: 'test-bash' });
const write = (r: BuiltGate, path: string, content: string) =>
  fileCall(r, 'write', 'test-write', path, { content });

describe('native tools (bash permission cases)', () => {
  it('allows workspace bash in accept-edits but asks for external directories', async () => {
    let approvals = 0;
    const r = await runtime({
      gear: 'accept-edits',
      approve: async () => {
        approvals++;
        return 'deny';
      },
    });
    // (The runtime case also checked the output said `local`: the command running.)
    await expect(bash(r, 'printf local')).resolves.toBeDefined();
    expect(approvals).toBe(0);
    await expect(bash(r, 'cd .. && pwd')).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
    r.gate.configure({ gear: 'ask' });
    await expect(bash(r, 'pwd')).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(2);
  });

  it('allows only inspection bash in plan mode regardless of gear', async () => {
    const r = await runtime({ mode: 'plan', gear: 'auto' });
    // (The runtime case also checked `pwd` printed the workspace: the command running.)
    await expect(bash(r, 'pwd')).resolves.toBe(r.cwd);
    for (const command of [
      'touch changed',
      'echo hi > changed',
      'pwd & touch changed',
      'file -C',
      'rg --pre=touch hi',
      'git diff --output=changed',
    ]) {
      await expect(bash(r, command), command).rejects.toMatchObject({ code: 'tool_denied' });
    }
  });

  it('requires approval for writes, denies secrets in auto, and refuses plan mutation', async () => {
    // An approver that always refuses: the claim is that the write REACHES the
    // gate, and a refusal is the visible half of that.
    const r = await runtime({ approve: async () => 'deny' });
    await expect(write(r, 'a', 'no')).rejects.toMatchObject({ code: 'tool_denied' });
    r.gate.configure({ gear: 'auto' });
    await expect(bash(r, 'cat .env')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(write(r, '.env', 'no')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(write(r, '.env.example', 'example')).resolves.toBeDefined();
    r.gate.configure({ mode: 'plan' });
    // The runtime dropped `write` from its tool list in plan mode (its own
    // registry); the gate's half of that is refusing the write.
    expect(
      r.gate.evaluate({ tool: 'write', toolCallId: 'plan-write', path: join(r.cwd, 'a') })
    ).toBe('deny');
  });

  it('enforces tool whitelist and path deny scopes before grants', async () => {
    const r = await runtime({
      gear: 'auto',
      allowedTools: ['read', 'write'],
      scopes: [{ root: dir, tools: ['write'], action: 'deny' }],
    });
    await expect(write(r, 'a', 'no')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(bash(r, 'pwd')).rejects.toMatchObject({ code: 'tool_denied' });
  });
});

describe('a bash grant, through the real shell analysis', () => {
  it('reads the segments the analysis already split, rather than re-lexing', async () => {
    const asked: ToolPermissionRequest[] = [];
    const r = await runtime({
      gear: 'ask',
      approve: async (request) => {
        asked.push(request);
        return 'allow-session';
      },
    });
    const run = (command: string) => bashCall(r, command);
    await run('echo one');
    expect(asked).toHaveLength(1);

    // Same program, different operand: one prefix, one grant, no second card.
    await run('echo two');
    expect(asked).toHaveLength(1);

    // A chain the analysis splits into two command nodes: the first is covered
    // and the second is not, so the line asks.
    await run('echo one && ls .');
    expect(asked).toHaveLength(2);
    expect(asked[1].commands).toEqual(expect.arrayContaining(['echo one', 'ls .']));
  });
});
