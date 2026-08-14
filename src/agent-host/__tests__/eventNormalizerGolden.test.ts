import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventNormalizer } from '../eventNormalizer.ts';

/**
 * OFF-position zero-regression arbiter (partial-messages batch, 片 1 test 10).
 *
 * `control.golden.json` was produced ONCE, by
 * `spikes/generate-partial-golden.ts`, running the normalizer as it stood at
 * commit `7a577a1` — the last commit before any partial-messages production
 * code existed. `control.sdk.json` is a control-position SDK transcript (zero
 * `stream_event`, exactly what the gateway sends when
 * `includePartialMessages` is absent or unhonoured), shaped after the spike's
 * 摘录 A/B control sequences: system/init, system/status, four
 * `system/thinking_tokens`, whole `assistant` thinking / tool_use / text, a
 * `user` tool_result, and a terminal `result`.
 *
 * The comparison is a STRICT deep equality over the entire emitted event
 * array — not a spot check. Any change to any emitted field, in any order,
 * turns this red. That is the point: it is the only mechanical guarantee that
 * the dedup state machine, the tool ledger, the token channel and the
 * coalescing emitter all stay completely inert when no `stream_event` ever
 * arrives (`partialContentSeen === false`).
 *
 * DO NOT regenerate the golden to make this pass. See the generator's header.
 */
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/partial-messages/', import.meta.url));

interface GoldenFile {
  generatedAtCommit: string;
  frozenNowMs: number;
  sessionId: string;
  requestId: string;
  userText: string;
  sdkFixture: string;
  events: Record<string, unknown>[];
}

const golden = JSON.parse(readFileSync(`${FIXTURE_DIR}control.golden.json`, 'utf8')) as GoldenFile;
const sdkMessages = JSON.parse(readFileSync(`${FIXTURE_DIR}control.sdk.json`, 'utf8')) as Array<
  Record<string, unknown>
>;

/**
 * The wire projection: Main forwards these events to the renderer, so an
 * `undefined`-valued key and an absent key are the same fact downstream. JSON
 * round-tripping the live events makes them directly comparable to the stored
 * golden while keeping `toStrictEqual` (extra keys, changed types, reordered
 * arrays all still fail).
 */
function onWire(events: Record<string, unknown>[]): unknown {
  return JSON.parse(JSON.stringify(events));
}

function runControlFixture(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const n = new EventNormalizer(
    golden.sessionId,
    (e) => events.push(e),
    () => undefined
  );
  n.beginTurn(golden.userText, undefined, golden.requestId);
  for (const message of sdkMessages) {
    n.ingest(message, golden.requestId);
  }
  return events;
}

describe('EventNormalizer OFF-position golden (partial-messages batch)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(golden.frozenNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the fixture pair is real and non-vacuous', () => {
    // Guards against the arbiter quietly going empty (a moved/emptied fixture
    // would otherwise make the deep-equality below trivially true).
    expect(golden.generatedAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(golden.sdkFixture).toBe('control.sdk.json');
    expect(sdkMessages.length).toBeGreaterThanOrEqual(10);
    expect(golden.events.length).toBeGreaterThanOrEqual(15);
    // The control position is defined by the ABSENCE of stream_event; if this
    // fixture ever grew one, the golden would stop testing the OFF path.
    expect(sdkMessages.some((m) => m.type === 'stream_event')).toBe(false);
    // The shapes the OFF path must keep covering.
    expect(sdkMessages.filter((m) => m.type === 'assistant')).toHaveLength(3);
    expect(sdkMessages.filter((m) => m.subtype === 'thinking_tokens')).toHaveLength(4);
    expect(sdkMessages.some((m) => m.type === 'user')).toBe(true);
    expect(sdkMessages.some((m) => m.type === 'result')).toBe(true);
  });

  it('emits the pre-change event stream byte-for-byte', () => {
    expect(onWire(runControlFixture())).toStrictEqual(golden.events);
  });

  it('schedules no timers at all on the control path', () => {
    // The Host-side delta coalescer (1e) is gated on `partialContentSeen`; a
    // control turn must never arm its 45ms backstop, so a bypass regression
    // (buffering control traffic) shows up here even before it changes output.
    runControlFixture();
    expect(vi.getTimerCount()).toBe(0);
  });
});
