import { describe, expect, it } from 'vitest';
import { isEngineUnsupportedSendError, parseSendDispatchErrorCode } from '../sendDispatchError';

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

/**
 * dsh-rebase P1-1, GUI point-check D2. The exact sentence the 2026-09-26 run
 * photographed: `WorkerManager` lets the bridge's `WorkerSlotError` through
 * unrenamed, so the code sits after the class name, inside Electron's wrapper.
 */
describe('isEngineUnsupportedSendError', () => {
  const REFUSED = new Error(
    "Error invoking remote method 'chat:send': WorkerSlotError: WORKER_DSH_UNSUPPORTED: Sending attachments is not bridged to the DSH engine yet"
  );

  it('recognises the bridge refusal as it reaches the composer', () => {
    expect(isEngineUnsupportedSendError(REFUSED)).toBe(true);
    expect(isEngineUnsupportedSendError('WORKER_DSH_UNSUPPORTED: x')).toBe(true);
  });

  it('is not a recoverable code: nothing retries it', () => {
    expect(parseSendDispatchErrorCode(REFUSED)).toBeNull();
  });

  it('reverse: other failures, and look-alike codes, are not it', () => {
    for (const other of [
      electronWrapped('session_busy: Session s1 already has active turn send-4'),
      electronWrapped('worker transport closed'),
      new Error('WORKER_DSH_UNSUPPORTED_V2: something else'),
      new Error('XWORKER_DSH_UNSUPPORTED: something else'),
      undefined,
      null,
    ]) {
      expect(isEngineUnsupportedSendError(other), String(other)).toBe(false);
    }
  });
});
