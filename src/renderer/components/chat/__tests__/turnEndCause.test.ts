import { describe, expect, it } from 'vitest';
import { type TurnEndCauseMessage, turnEndCause, turnEndedByUser } from '../turnEndCause';

const assistant = (extra: Partial<TurnEndCauseMessage> = {}): TurnEndCauseMessage => ({
  role: 'assistant',
  ...extra,
});

describe('turnEndCause', () => {
  it('reads the stamp off the last assistant message', () => {
    expect(turnEndCause([assistant(), assistant({ stopCause: 'interjected' })])).toBe(
      'interjected'
    );
    expect(turnEndCause([assistant({ stopCause: 'user_stop' })])).toBe('user_stop');
  });

  it('looks past trailing notices', () => {
    expect(
      turnEndCause([assistant({ stopCause: 'user_stop' }), { role: 'error' }, { role: 'system' }])
    ).toBe('user_stop');
  });

  it('ignores a stamp on an earlier message when a later run finished normally', () => {
    expect(turnEndCause([assistant({ stopCause: 'interjected' }), assistant()])).toBeNull();
  });

  it('is null for a turn that ended on its own, has no reply, or is still running', () => {
    expect(turnEndCause([assistant({ stopReason: 'stop' })])).toBeNull();
    expect(turnEndCause([assistant({ stopReason: 'toolUse' })])).toBeNull();
    expect(turnEndCause([])).toBeNull();
    expect(turnEndCause([{ role: 'error' }])).toBeNull();
  });

  it('reads an aborted reply from older history as a user stop', () => {
    expect(turnEndCause([assistant({ stopReason: 'aborted' })])).toBe('user_stop');
    expect(turnEndCause([assistant({ stopReason: 'error' })])).toBeNull();
  });

  it('turnEndedByUser is the boolean view', () => {
    expect(turnEndedByUser([assistant({ stopCause: 'interjected' })])).toBe(true);
    expect(turnEndedByUser([assistant({ stopReason: 'stop' })])).toBe(false);
  });
});
