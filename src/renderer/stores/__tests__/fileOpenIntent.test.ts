import { describe, expect, it } from 'vitest';
import { nextIntent } from '../fileOpenIntent';

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
});
