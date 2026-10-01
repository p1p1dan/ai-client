import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionGear } from '../../types/runtimePermission.ts';
import type { PermissionActivityRecord, ToolPermissionRequest } from '../gate.ts';
import { type BuiltGate, buildGate, fileCall } from './gateHarness.ts';

/**
 * Moved from the SA10 group of src/runtime/__tests__/subagentToolsPermissions.test.ts
 * (dsh-rebase P1-12 step 2): a delegate's call resolves through the same gate
 * as the parent's, carries the delegate's name onto the card and the audit
 * row, cannot cross a deny whatever gear it runs under, inherits a session's
 * bypass, and leaves no scope behind.
 *
 * The three SA10 cases about a gear a delegate DEFINITION declares are not
 * here: DSH's agent presets have no permission field (shard 04 §3, class C;
 * evidence/p1-12-permission-case-map.md).
 */

let workspace: string;
let built: BuiltGate | undefined;
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'perm-delegate-')));
});
afterEach(async () => {
  built?.gate.dispose();
  built = undefined;
  await rm(workspace, { recursive: true, force: true });
});

async function build(gear: PermissionGear) {
  const seen: ToolPermissionRequest[] = [];
  const activity: PermissionActivityRecord[] = [];
  built = await buildGate(workspace, {
    gear,
    approve: async (request) => {
      seen.push(request);
      return 'allow-once';
    },
  });
  built.gate.onActivity((record) => activity.push(record));
  return { built, permissions: built.gate, seen, activity };
}

/** The runtime `write` tool up to its approval. */
const write = (gate: BuiltGate, id: string, path: string, content: string) =>
  fileCall(gate, 'write', id, path, { content });

/** The runtime `read` tool up to its approval. */
const read = (gate: BuiltGate, id: string, path: string) => fileCall(gate, 'read', id, path);

describe('SA10 · a delegate resolves under its own scope, and says who it is', () => {
  it('puts the delegate on the approval card', async () => {
    const { built: gate, permissions, seen, activity } = await build('ask');

    const release = permissions.scopeToolCall('delegate-call', {
      delegation: { delegationId: 'd7', agentName: 'fixer' },
    });
    await write(gate, 'delegate-call', 'x.txt', 'x');
    release();

    // "Allow this write?" is a different question depending on who is asking.
    expect(seen).toHaveLength(1);
    expect(seen[0].delegation).toEqual({ delegationId: 'd7', agentName: 'fixer' });
    const prompt = activity.find((record) => record.phase === 'prompt');
    expect(prompt?.request.delegation?.agentName).toBe('fixer');
  });

  it('does not let an explicit auto scope cross a deny', async () => {
    const { built: gate, permissions } = await build('ask');
    const release = permissions.scopeToolCall('delegate-call', {
      gear: 'auto',
      delegation: { delegationId: 'd3', agentName: 'explorer' },
    });
    // A path the default policy denies outright; the file exists, so the
    // refusal is the policy talking.
    await writeFile(join(workspace, '.env'), 'TOKEN=secret\n', 'utf8');
    await expect(read(gate, 'delegate-call', join(workspace, '.env'))).rejects.toMatchObject({
      code: 'tool_denied',
    });
    release();
  });

  it('lets an inheriting delegate run under the session bypass', async () => {
    const { built: gate, permissions, seen, activity } = await build('bypass');

    // No `gear` on the scope — that IS `inherit`.
    const release = permissions.scopeToolCall('delegate-call', {
      delegation: { delegationId: 'd9', agentName: 'fixer' },
    });
    await write(gate, 'delegate-call', 'by-delegate.txt', 'hi');
    release();

    // Allowed with no card. (The runtime suite also read the file back; that
    // half was the tool running, which this library does not do.)
    expect(seen).toHaveLength(0);
    // The audit row names the gear the call resolved under, and the delegate.
    const decision = activity.find((record) => record.phase === 'decision');
    expect(decision?.gear).toBe('bypass');
    expect(decision?.request.delegation?.agentName).toBe('fixer');
  });

  it('does not let a session on bypass cross a deny, for parent or delegate', async () => {
    const { built: gate, permissions } = await build('bypass');
    // Both files EXIST, so a refusal here is the policy talking.
    await mkdir(join(workspace, 'keys'), { recursive: true });
    await writeFile(join(workspace, 'keys', 'server.pem'), 'KEY\n', 'utf8');
    await writeFile(join(workspace, '.env'), 'TOKEN=secret\n', 'utf8');
    const release = permissions.scopeToolCall('delegate-call', {
      delegation: { delegationId: 'd10', agentName: 'explorer' },
    });
    // Bypass answers asks; it does not repeal denies.
    await expect(
      read(gate, 'delegate-call', join(workspace, 'keys', 'server.pem'))
    ).rejects.toMatchObject({ code: 'tool_denied' });
    release();
    await expect(read(gate, 'parent-call', join(workspace, '.env'))).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });

  it('releases the scope even when the call throws', async () => {
    const { built: gate, permissions } = await build('ask');
    const release = permissions.scopeToolCall('shared-id', { gear: 'auto' });
    // The runtime `read` failed after its approval, opening a file that is not
    // there; the same failure, after the same approval.
    await expect(
      read(gate, 'shared-id', 'nope.txt').then((target) => stat(target))
    ).rejects.toThrow();
    release();
    // A leaked scope would silently run a later parent call on `auto`.
    const decisionGear = permissions.evaluate({
      tool: 'write',
      toolCallId: 'shared-id',
      path: join(workspace, 'later.txt'),
    });
    expect(decisionGear).toBe('ask');
  });
});
