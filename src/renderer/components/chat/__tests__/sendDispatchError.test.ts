import { describe, expect, it } from 'vitest';
import { parseSendDispatchErrorCode } from '../sendDispatchError';

/**
 * The strings here are the real wire shape, not simplified: `chat.ts`
 * re-throws as `<code>: <message>` and Electron wraps that again with its own
 * "Error invoking remote method" prefix, so the code always arrives buried in
 * the middle of a longer sentence.
 */
const electronWrapped = (inner: string) =>
  new Error(`Error invoking remote method 'chat:send': Error: ${inner}`);

describe('parseSendDispatchErrorCode', () => {
  it('finds session_not_found inside the Electron wrapper', () => {
    expect(
      parseSendDispatchErrorCode(
        electronWrapped('session_not_found: No ready Pi WorkerSlot exists for s1')
      )
    ).toBe('session_not_found');
  });

  it('finds session_busy inside the Electron wrapper', () => {
    expect(
      parseSendDispatchErrorCode(
        electronWrapped('session_busy: Session s1 already has active turn send-4')
      )
    ).toBe('session_busy');
  });

  // `pi_session_not_found` is a DIFFERENT failure — the session index has no
  // row at all — and must not be steered into the create-a-new-session
  // recovery built for an evicted-but-known session.
  it('does not read pi_session_not_found as session_not_found', () => {
    expect(
      parseSendDispatchErrorCode(
        electronWrapped('pi_session_not_found: No indexed Pi session file for s1')
      )
    ).toBeNull();
  });

  it('ignores codes with no recovery branch', () => {
    expect(
      parseSendDispatchErrorCode(
        electronWrapped('invalid_send_attempt: Pi send attemptId must be non-empty')
      )
    ).toBeNull();
    expect(parseSendDispatchErrorCode(electronWrapped('worker transport closed'))).toBeNull();
  });

  it('accepts a bare code at the head of the message', () => {
    expect(parseSendDispatchErrorCode(new Error('session_busy: try again'))).toBe('session_busy');
  });

  it('survives a non-Error rejection', () => {
    expect(parseSendDispatchErrorCode('session_not_found: gone')).toBe('session_not_found');
    expect(parseSendDispatchErrorCode(undefined)).toBeNull();
    expect(parseSendDispatchErrorCode(null)).toBeNull();
  });
});
