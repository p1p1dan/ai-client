/**
 * Unit smoke: EventNormalizer.finishTurn — synthetic terminals when the SDK
 * stream ends without a result event (team ledger 2026-07-24 finding).
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/phase2-stream-end-unit.ts
 *
 * Scenarios:
 *   1. result arrived  → finishTurn 'already', no extra events
 *   2. assistant text, no result → 'completed', emits message/session.completed + idle
 *   3. nothing after user echo   → 'failed', emits session.failed + status failed
 */

import { EventNormalizer } from '../eventNormalizer.ts';

interface Emitted {
  type?: string;
  payload?: { status?: string; error?: string };
}

function collect(): { events: Emitted[]; normalizer: EventNormalizer } {
  const events: Emitted[] = [];
  const normalizer = new EventNormalizer('unit-session', (e) => {
    events.push(e as Emitted);
  });
  return { events, normalizer };
}

const types = (events: Emitted[]) => events.map((e) => e.type);
const failures: string[] = [];
function expect(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(`${label}${detail ? ` (${detail})` : ''}`);
}

// Scenario 1: result already emitted terminals → finishTurn is a no-op.
{
  const { events, normalizer } = collect();
  normalizer.beginTurn('PING', 'req-1');
  normalizer.ingest(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } },
    'req-1'
  );
  normalizer.ingest({ type: 'result', subtype: 'success', result: 'PONG' }, 'req-1');
  const before = events.length;
  const outcome = normalizer.finishTurn('req-1');
  expect('s1 outcome already', outcome === 'already', outcome);
  expect('s1 no extra events', events.length === before, `${events.length - before} extra`);
  expect(
    's1 result emitted completed+idle',
    types(events).includes('session.completed') &&
      events.some((e) => e.type === 'session.status' && e.payload?.status === 'idle')
  );
}

// Scenario 2: assistant output but stream ended without result.
{
  const { events, normalizer } = collect();
  normalizer.beginTurn('PING', 'req-2');
  normalizer.ingest(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial…' }] } },
    'req-2'
  );
  const outcome = normalizer.finishTurn('req-2');
  const tail = types(events).slice(-3);
  expect('s2 outcome completed', outcome === 'completed', outcome);
  expect(
    's2 tail message.completed→session.completed→idle',
    tail[0] === 'message.completed' &&
      tail[1] === 'session.completed' &&
      tail[2] === 'session.status',
    tail.join(',')
  );
  expect(
    's2 status idle',
    events.some((e) => e.type === 'session.status' && e.payload?.status === 'idle')
  );
}

// Scenario 3: nothing assistant-related arrived at all.
{
  const { events, normalizer } = collect();
  normalizer.beginTurn('PING', 'req-3');
  const outcome = normalizer.finishTurn('req-3');
  expect('s3 outcome failed', outcome === 'failed', outcome);
  expect('s3 session.failed emitted', types(events).includes('session.failed'));
  expect(
    's3 status failed with error text',
    events.some((e) => e.type === 'session.status' && e.payload?.status === 'failed') &&
      events.some((e) => e.type === 'session.failed' && Boolean(e.payload?.error))
  );
  expect('s3 no session.completed', !types(events).includes('session.completed'));
}

const ok = failures.length === 0;
console.log(JSON.stringify({ ok, failures }, null, 2));
process.exitCode = ok ? 0 : 2;
