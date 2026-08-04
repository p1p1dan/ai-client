import { describe, expect, it } from 'vitest';
import { ackIntent, nextIntent } from '../fileOpenIntent';

describe('nextIntent', () => {
  it('starts requestId at 1 from a null previous intent', () => {
    const intent = nextIntent(null, { path: 'a.ts', source: 'tool-row' });
    expect(intent.requestId).toBe(1);
  });

  it('increments requestId on every call, even for the exact same path', () => {
    const first = nextIntent(null, { path: 'a.ts', source: 'tool-row' });
    const second = nextIntent(first, { path: 'a.ts', source: 'tool-row' });
    expect(second.requestId).toBe(first.requestId + 1);
  });

  it('passes line/endLine through unchanged', () => {
    const intent = nextIntent(null, { path: 'a.ts', line: 10, endLine: 20, source: 'hit-list' });
    expect(intent.line).toBe(10);
    expect(intent.endLine).toBe(20);
    expect(intent.source).toBe('hit-list');
  });

  it('accepts the mention-chip source and passes it through unchanged', () => {
    const intent = nextIntent(null, { path: 'a.ts', source: 'mention-chip' });
    expect(intent.source).toBe('mention-chip');
  });
});

describe('ackIntent', () => {
  it('clears the current intent when requestId matches', () => {
    const intent = nextIntent(null, { path: 'a.ts', source: 'tool-row' });
    expect(ackIntent(intent, intent.requestId)).toBeNull();
  });

  it('leaves a newer intent untouched when acking a stale requestId', () => {
    const first = nextIntent(null, { path: 'a.ts', source: 'tool-row' });
    const second = nextIntent(first, { path: 'b.ts', source: 'hit-list' });
    // A consumer still resolving `first` finishes late and acks the OLD id —
    // must not clear `second`, which arrived in the meantime.
    expect(ackIntent(second, first.requestId)).toBe(second);
  });

  it('is a no-op when there is no current intent', () => {
    expect(ackIntent(null, 1)).toBeNull();
  });
});
