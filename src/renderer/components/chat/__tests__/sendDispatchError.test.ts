import { describe, expect, it } from 'vitest';
import { parseAttachmentRejection, parseSendDispatchErrorCode } from '../sendDispatchError';

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
 * dsh-rebase P1-4c2 (decision 096), on P1-1 D2's path. The wire shape: the
 * bridge's `WORKER_ATTACHMENT_REJECTED` reaches Main as a `WorkerSlotError`
 * (`<code>: <message>`), which `WorkerManager` lets through unrenamed, inside
 * Electron's wrapper. The message is `<DSH code> "<file name>": <sentence>`.
 */
describe('parseAttachmentRejection', () => {
  const wrapped = (inner: string) =>
    new Error(
      `Error invoking remote method 'chat:send': WorkerSlotError: WORKER_ATTACHMENT_REJECTED: ${inner}`
    );
  const REFUSED = wrapped(
    'IMAGE_DIMENSION_TOO_LARGE "wide.png": Image exceeds the configured per-side pixel limit.'
  );

  it('reads the DSH code and the file to blame as they reach the composer', () => {
    expect(parseAttachmentRejection(REFUSED)).toEqual({
      code: 'IMAGE_DIMENSION_TOO_LARGE',
      name: 'wide.png',
    });
    expect(
      parseAttachmentRejection(
        wrapped(`IMAGE_TYPE_MISMATCH ${JSON.stringify('a "quoted" name.jpg')}: x`)
      )
    ).toEqual({ code: 'IMAGE_TYPE_MISMATCH', name: 'a "quoted" name.jpg' });
  });

  it('has no name when the whole batch is refused', () => {
    expect(
      parseAttachmentRejection(wrapped('TOO_MANY_IMAGES: Image batch exceeds the limit.'))
    ).toEqual({ code: 'TOO_MANY_IMAGES' });
  });

  it('is not a recoverable code: nothing retries it', () => {
    expect(parseSendDispatchErrorCode(REFUSED)).toBeNull();
  });

  it('reverse: other failures, the old refusal and look-alike codes are not it', () => {
    for (const other of [
      electronWrapped('session_busy: Session s1 already has active turn send-4'),
      electronWrapped('worker transport closed'),
      new Error(
        "Error invoking remote method 'chat:send': WorkerSlotError: WORKER_DSH_UNSUPPORTED: Sending attachments is not bridged to the DSH engine yet"
      ),
      new Error('WORKER_ATTACHMENT_REJECTED_V2: IMAGE_TOO_LARGE "a.png": x'),
      new Error('XWORKER_ATTACHMENT_REJECTED: IMAGE_TOO_LARGE "a.png": x'),
      undefined,
      null,
    ]) {
      expect(parseAttachmentRejection(other), String(other)).toBeNull();
    }
  });
});
