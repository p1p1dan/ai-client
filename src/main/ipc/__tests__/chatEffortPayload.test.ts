import type {
  SessionCreateCommand,
  SessionEffortLevel,
  SessionSendCommand,
} from '@shared/types/agentHost';
import { describe, expect, it } from 'vitest';

/**
 * T-20 wiring lock: the `effort` field must survive the Renderer → Main → Host
 * hop as an own enumerable property.
 *
 * Why this exists: `ipcRenderer.invoke` returns `Promise<any>` and the Main-side
 * handler signatures are hand-written inline types, so `tsc` cannot catch a
 * dropped field anywhere along this chain — a payload that quietly loses
 * `effort` type-checks perfectly and fails only at runtime, silently falling
 * back to the model default. (The same class of trap as T-07③, where a
 * non-enumerable `total` would not have survived structured clone.)
 *
 * These assertions are structural: they pin that the protocol payload types
 * accept `effort`, and that a payload built the way ChatComposer builds it
 * survives `structuredClone` — which is what the IPC bridge actually does.
 */

describe('session.create payload carries effort across the IPC bridge', () => {
  it('accepts effort on the protocol payload type', () => {
    const payload: SessionCreateCommand['payload'] = {
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'opus',
      effort: 'xhigh',
    };
    expect(payload.effort).toBe('xhigh');
  });

  it('survives structured clone with effort intact', () => {
    const payload: SessionCreateCommand['payload'] = {
      sessionId: 's1',
      workspacePath: '/repo',
      effort: 'high',
    };
    expect(structuredClone(payload).effort).toBe('high');
  });

  it('omits the key entirely when the user leaves the selector on Default', () => {
    // Mirrors ChatComposer: `...(effort ? { effort } : {})` with effort undefined.
    const effort: SessionEffortLevel | undefined = undefined;
    const payload: SessionCreateCommand['payload'] = {
      sessionId: 's1',
      workspacePath: '/repo',
      ...(effort ? { effort } : {}),
    };
    expect(payload).not.toHaveProperty('effort');
    expect(structuredClone(payload)).not.toHaveProperty('effort');
  });
});

describe('session.send payload carries a per-turn effort override', () => {
  it('accepts effort alongside text and attachments', () => {
    const payload: SessionSendCommand['payload'] = {
      sessionId: 's1',
      text: 'hi',
      effort: 'low',
    };
    expect(structuredClone(payload).effort).toBe('low');
  });

  it('omits the key when no override is chosen', () => {
    const payload: SessionSendCommand['payload'] = { sessionId: 's1', text: 'hi' };
    expect(structuredClone(payload)).not.toHaveProperty('effort');
  });
});
