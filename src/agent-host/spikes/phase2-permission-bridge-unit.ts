/**
 * Unit smoke for PermissionBridge (no SDK / no API credentials required).
 *
 * Usage:
 *   node --experimental-strip-types spikes/phase2-permission-bridge-unit.ts
 */

import { PermissionBridge } from '../permissionBridge.ts';

async function main(): Promise<void> {
  const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const emit = (event: Record<string, unknown>) => {
    events.push(event as { type?: string; payload?: Record<string, unknown> });
  };

  const bridge = new PermissionBridge(emit);
  const abort = new AbortController();
  const canUseTool = bridge.createCanUseTool('sess-1');

  const pending = canUseTool(
    'Bash',
    { command: 'echo PERM-OK' },
    {
      signal: abort.signal,
      toolUseID: 'toolu_test_1',
      description: 'Run echo',
    }
  );

  const requested = events.find((e) => e.type === 'permission.requested');
  if (!requested) {
    throw new Error('expected permission.requested');
  }
  const permissionId = String(requested.payload?.permissionId ?? '');
  if (permissionId !== 'toolu_test_1') {
    throw new Error(`expected permissionId toolu_test_1, got ${permissionId}`);
  }

  const waiting = events.some(
    (e) => e.type === 'session.status' && e.payload?.status === 'waiting_permission'
  );
  if (!waiting) {
    throw new Error('expected waiting_permission status');
  }

  const ok = bridge.respond({
    sessionId: 'sess-1',
    permissionId,
    allow: true,
  });
  if (!ok) throw new Error('respond returned false');

  const result = await pending;
  if (result.behavior !== 'allow') {
    throw new Error(`expected allow, got ${JSON.stringify(result)}`);
  }

  const resolved = events.find((e) => e.type === 'permission.resolved');
  if (!resolved || resolved.payload?.allow !== true) {
    throw new Error('expected permission.resolved allow=true');
  }

  // Second respond must fail (exactly once).
  const again = bridge.respond({
    sessionId: 'sess-1',
    permissionId,
    allow: false,
  });
  if (again) throw new Error('duplicate respond should fail');

  // Abort path: pending denied with interrupt.
  const abort2 = new AbortController();
  const pending2 = canUseTool(
    'Write',
    { path: 'x.txt' },
    { signal: abort2.signal, toolUseID: 'toolu_test_2' }
  );
  abort2.abort();
  const denied = await pending2;
  if (denied.behavior !== 'deny' || !denied.interrupt) {
    throw new Error(`expected deny+interrupt, got ${JSON.stringify(denied)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventTypes: events.map((e) => e.type),
        notes: ['request→respond allow', 'duplicate respond rejected', 'abort→deny interrupt'],
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
