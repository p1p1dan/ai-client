import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';
import { PermissionGate, type ToolPermissionRequest } from '../gate.ts';
import { describeGrantScope, grantsFor } from '../grants.ts';
import { type Approver, type BuiltGate, buildGate, type GateOptions } from './gateHarness.ts';

/**
 * dsh-rebase decision 190 — `web_fetch` at the gate: a network access judged
 * by the gear like any call with no file target, on its host (policy rules,
 * session grants), allowed in plan mode like a read.
 */

let dir: string;
const gates: PermissionGate[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-network-')));
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.dispose();
  await rm(dir, { recursive: true, force: true });
});

const neverAsked: Approver = (request) => {
  throw new Error(`unexpected permission request for ${request.tool}`);
};

async function gate(options: GateOptions = {}): Promise<BuiltGate> {
  const built = await buildGate(dir, { approve: neverAsked, ...options });
  gates.push(built.gate);
  return built;
}

/** What the permission row sends for `web_fetch({url})` (requestBuilder.ts). */
function fetchRequest(cwd: string, host: string, toolCallId = 'f1'): ToolPermissionRequest {
  return {
    tool: 'web_fetch',
    toolCallId,
    path: cwd,
    policySurface: 'web_fetch',
    policyValue: host,
    network: true,
    preview: { label: 'URL', text: `https://${host}/page` },
  };
}

describe('decision 190: a fetch at the gate', () => {
  it.each([
    ['ask', 'ask'],
    ['accept-edits', 'ask'],
    ['auto', 'allow'],
    ['bypass', 'allow'],
  ] as const)('agent / %s: %s', async (gear, expected) => {
    const built = await gate({ mode: 'agent', gear });
    expect(built.gate.evaluate(fetchRequest(built.cwd, 'example.com'))).toBe(expected);
  });

  it('is allowed through plan mode like a read, still under the gear', async () => {
    const asking = await gate({ mode: 'plan', gear: 'ask' });
    expect(asking.gate.evaluate(fetchRequest(asking.cwd, 'example.com'))).toBe('ask');
    const auto = await gate({ mode: 'plan', gear: 'auto' });
    expect(auto.gate.evaluate(fetchRequest(auto.cwd, 'example.com'))).toBe('allow');
    // A write stays refused there.
    expect(
      auto.gate.evaluate({ tool: 'write', toolCallId: 'w', path: join(auto.cwd, 'a.txt') })
    ).toBe('deny');
  });

  it('follows the policy for the host: deny over every gear, allow without a card', async () => {
    const agentDir = join(dir, 'agent');
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'pi-permissions.jsonc'),
      JSON.stringify({
        permission: { web_fetch: { '*': 'ask', '*.python.org': 'allow', 'evil.test': 'deny' } },
      })
    );
    const asking = await gate({ mode: 'agent', gear: 'ask', agentDir });
    expect(asking.gate.evaluate(fetchRequest(asking.cwd, 'docs.python.org'))).toBe('allow');
    expect(asking.gate.evaluate(fetchRequest(asking.cwd, 'python.org'))).toBe('ask');
    expect(asking.gate.evaluate(fetchRequest(asking.cwd, 'evil.test'))).toBe('deny');
    const bypass = await gate({ mode: 'agent', gear: 'bypass', agentDir });
    expect(bypass.gate.evaluate(fetchRequest(bypass.cwd, 'evil.test'))).toBe('deny');
  });

  it('remembers "Allow for session" for the host, not for every site', async () => {
    const asked: string[] = [];
    const built = await gate({
      mode: 'agent',
      gear: 'ask',
      approve: async (request) => {
        asked.push(String(request.policyValue));
        return 'allow-session';
      },
    });
    await built.gate.authorize(fetchRequest(built.cwd, 'example.com', 'f1'));
    await built.gate.authorize(fetchRequest(built.cwd, 'example.com', 'f2'));
    expect(asked).toEqual(['example.com']);
    expect(built.gate.evaluate(fetchRequest(built.cwd, 'other.example', 'f3'))).toBe('ask');
    expect(grantsFor(fetchRequest(built.cwd, 'example.com'))).toEqual([
      { kind: 'value', tool: 'web_fetch', value: 'example.com' },
    ]);
  });

  it('asks when the gate has no policy at all', () => {
    const bare = new PermissionGate({ cwd: dir, mode: 'agent', gear: 'ask' });
    gates.push(bare);
    expect(bare.evaluate(fetchRequest(dir, 'example.com'))).toBe('ask');
  });

  it('describes the grant as the host, and words the card fetch_url with the URL', async () => {
    expect(describeGrantScope(fetchRequest(dir, 'example.com'), dir)).toEqual({
      kind: 'host',
      value: 'example.com',
    });
    const events: RuntimeEventDraft[] = [];
    const prompt = createPermissionPrompt({
      sessionId: 's1',
      cwd: dir,
      emit: (event) => events.push(event),
    });
    const answer = prompt.approve(fetchRequest(dir, 'example.com'), new AbortController().signal);
    expect(prompt.respond({ permissionId: 'f1', decision: 'allow' })).toBe(true);
    expect(await answer).toBe('allow-once');
    const requested = events.find((event) => event.type === 'permission.requested');
    expect(requested?.payload).toMatchObject({
      toolName: 'web_fetch',
      action: 'fetch_url',
      kind: 'tool',
      input: { content: 'https://example.com/page', contentLabel: 'URL' },
      sessionGrantScope: { kind: 'host', value: 'example.com' },
      decisions: ['allow', 'allow_session', 'deny'],
    });
  });
});
