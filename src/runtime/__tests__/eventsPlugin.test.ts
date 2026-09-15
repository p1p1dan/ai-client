/**
 * Subscriber isolation on the event bus.
 *
 * Every runtime event goes through one synchronous fan-out. The emitters are
 * the agent loop and the projector, mid-turn; the subscriber is a worker sink
 * that writes an RPC port. A port that has gone away is the realistic throw,
 * and an exception from there used to end the turn with a transport error and
 * cut every other subscriber out of that event.
 */
import { Context } from 'cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { EventsPlugin } from '../events/index.ts';

function draft(status: 'running' | 'idle'): RuntimeEventDraft {
  return { type: 'session.status', sessionId: 'S1', payload: { status } };
}

async function events(): Promise<{ ctx: Context; events: EventsPlugin }> {
  const ctx = new Context();
  const fiber = await ctx.plugin(EventsPlugin);
  await fiber.await();
  return { ctx, events: ctx.runtimeEvents as EventsPlugin };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventsPlugin.emit', () => {
  it('keeps delivering after a subscriber throws, and does not fail the emitter', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ctx, events: bus } = await events();
    const before: RuntimeEventDraft[] = [];
    const after: RuntimeEventDraft[] = [];
    bus.subscribe((event) => before.push(event));
    bus.subscribe(() => {
      throw new Error('the port is closed');
    });
    bus.subscribe((event) => after.push(event));
    expect(() => bus.emit(draft('running'))).not.toThrow();
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('session.status');
    await ctx.fiber.dispose();
  });

  it('delivers to the subscribers present when the event was emitted', async () => {
    const { ctx, events: bus } = await events();
    const seen: string[] = [];
    let unsubscribeSecond = () => undefined as void;
    bus.subscribe(() => {
      seen.push('first');
      // Iterating the live set would skip the peer this one just removed.
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.subscribe(() => seen.push('second'));
    bus.subscribe(() => seen.push('third'));
    bus.emit(draft('running'));
    expect(seen).toEqual(['first', 'second', 'third']);
    bus.emit(draft('idle'));
    expect(seen).toEqual(['first', 'second', 'third', 'first', 'third']);
    await ctx.fiber.dispose();
  });
});
