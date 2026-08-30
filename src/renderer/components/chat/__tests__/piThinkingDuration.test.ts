import { describe, expect, it } from 'vitest';
import { formatThoughtRow, initialTurnTimingRegistry, reduceTurnTiming } from '../turnTiming';

/**
 * T12-c — the renderer half of "how long did it think".
 *
 * `reduceTurnTiming` measures a thought as `thinking.completed.timestamp -
 * thinking.started.timestamp`. pi has no "thinking ended" event, so before
 * this batch the Host emitted only the `started` half: `durationMs` stayed
 * null and `formatThoughtRow` fell to its historical-message branch — a bare
 * `Thought`, on EVERY thought, on every pi turn.
 *
 * That branch is not a bug on its own (restored history genuinely has no
 * timing, and inventing one would be worse). It was just answering a question
 * nobody had asked yet.
 *
 * `piRuntimeMessageBoundaries.test.ts` holds the Host half.
 */

const BLOCK = 'asst-1-thinking';

/**
 * `TurnTimingEvent` is module-local by design — the reducer takes it
 * structurally. Declaring the shape here rather than exporting the type keeps
 * the production module's surface unchanged for a test's convenience.
 */
interface TimingEvent {
  type: string;
  timestamp?: number;
  payload?: unknown;
}

function ev(type: 'thinking.started' | 'thinking.completed', timestamp: number): TimingEvent {
  return { type, timestamp, payload: { messageId: 'asst-1', blockId: BLOCK } };
}

function durationAfter(events: readonly TimingEvent[]): number | null | undefined {
  let registry = initialTurnTimingRegistry;
  for (const event of events) registry = reduceTurnTiming(registry, event);
  return registry.byBlock[BLOCK]?.durationMs;
}

describe('pi thinking duration', () => {
  it('resolves once the Host closes the thought', () => {
    expect(durationAfter([ev('thinking.started', 1_000), ev('thinking.completed', 8_000)])).toBe(
      7_000
    );
  });

  it('stays unresolved with only the started half — the pre-fix pi behaviour', () => {
    // Kept as a named case rather than deleted: this is exactly what the pi
    // backend produced, and it is what the bare `Thought` on screen meant.
    expect(durationAfter([ev('thinking.started', 1_000)])).toBeUndefined();
  });

  it('renders a real duration instead of a bare "Thought"', () => {
    const durationMs = durationAfter([
      ev('thinking.started', 1_000),
      ev('thinking.completed', 8_000),
    ]);
    expect(formatThoughtRow({ durationMs })).toEqual({
      verb: 'Thought',
      arg: 'for 7s',
      argKind: 'prose',
    });
    // The shape it used to have on pi, every time.
    expect(formatThoughtRow({ durationMs: null })).toEqual({ verb: 'Thought' });
  });

  it('says "briefly" for a short thought rather than a jittery second count', () => {
    const durationMs = durationAfter([
      ev('thinking.started', 1_000),
      ev('thinking.completed', 2_000),
    ]);
    expect(formatThoughtRow({ durationMs })).toMatchObject({ verb: 'Thought', arg: 'briefly' });
  });

  it('would inflate the duration if the Host closed a thought twice', () => {
    // Why `completeThinking` is idempotent on the Host side: a second
    // `thinking.completed` overwrites the measurement with the later stamp.
    // 7s of thinking would be reported as 60s because the message happened to
    // end a minute later.
    expect(
      durationAfter([
        ev('thinking.started', 1_000),
        ev('thinking.completed', 8_000),
        ev('thinking.completed', 61_000),
      ])
    ).toBe(60_000);
  });
});
