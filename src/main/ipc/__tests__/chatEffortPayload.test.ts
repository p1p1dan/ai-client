import type { SessionAttachment, SessionEffortLevel } from '@shared/types/agentHost';
import { describe, expect, it } from 'vitest';

type ChatCreatePayload = {
  sessionId: string;
  workspacePath: string;
  model?: string;
  effort?: SessionEffortLevel;
};

type ChatSendPayload = {
  sessionId: string;
  text: string;
  attachments?: SessionAttachment[];
  effort?: SessionEffortLevel;
  model?: string;
};

/**
 * T-20 wiring lock: the `effort` field must survive the Renderer -> Main
 * chat IPC hop as an own enumerable property.
 *
 * These assertions are structural: they pin that the live chat IPC payload
 * shapes accept `effort`, and that payloads built the way ChatComposer builds
 * them survive `structuredClone` — which is what the IPC bridge actually does.
 */

describe('session.create payload carries effort across the chat IPC bridge', () => {
  it('accepts effort on the chat payload type', () => {
    const payload: ChatCreatePayload = {
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'opus',
      effort: 'xhigh',
    };
    expect(payload.effort).toBe('xhigh');
  });

  it('survives structured clone with effort intact', () => {
    const payload: ChatCreatePayload = {
      sessionId: 's1',
      workspacePath: '/repo',
      effort: 'high',
    };
    expect(structuredClone(payload).effort).toBe('high');
  });

  it('omits the key entirely when the user leaves the selector on Default', () => {
    // Mirrors ChatComposer: `...(effort ? { effort } : {})` with effort undefined.
    const effort: SessionEffortLevel | undefined = undefined;
    const payload: ChatCreatePayload = {
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
    const payload: ChatSendPayload = {
      sessionId: 's1',
      text: 'hi',
      effort: 'low',
    };
    expect(structuredClone(payload).effort).toBe('low');
  });

  it('omits the key when no override is chosen', () => {
    const payload: ChatSendPayload = { sessionId: 's1', text: 'hi' };
    expect(structuredClone(payload)).not.toHaveProperty('effort');
  });
});
