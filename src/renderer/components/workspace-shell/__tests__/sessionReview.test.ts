import type { SessionFileChange } from '@shared/sessionFileChange';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chatSessions';
import { deriveSessionReview } from '../sessionReview';

function reviewMessage(id: string, review: SessionFileChange): ChatMessage {
  return {
    id,
    sessionId: 's',
    role: 'assistant',
    blocks: [
      {
        id: `${id}-call`,
        type: 'tool_call',
        toolCallId: id,
        toolName: 'write',
        toolInput: { path: review.path, content: 'pong\n' },
      },
      {
        id: `${id}-result`,
        type: 'tool_result',
        toolCallId: id,
        toolOk: true,
        toolOutput: { content: [{ type: 'text', text: 'written' }], details: { review } },
      },
    ],
  };
}

describe('session review projection', () => {
  it('reuses entries of messages a streaming delta did not touch', () => {
    const done = reviewMessage('one', { version: 1, path: 'a', status: 'added', patch: '+x' });
    const live: ChatMessage = { id: 'live', sessionId: 's', role: 'assistant', blocks: [] };
    const before = deriveSessionReview([done, live]);
    const after = deriveSessionReview([
      done,
      { ...live, blocks: [{ id: 't', type: 'text', text: 'hi' }] },
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(before[0]);
  });
  it('keeps a provider call id reused by a later message', () => {
    const first = reviewMessage('reused', { version: 1, path: 'a', status: 'added', patch: '+x' });
    expect(deriveSessionReview([first, { ...first, id: 'later-message' }])).toHaveLength(2);
  });
  it('keeps two changes to one path and never consults the filesystem', () => {
    const first = reviewMessage('one', {
      version: 1,
      path: 'test.txt',
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+pong',
    });
    const second = reviewMessage('two', {
      version: 1,
      path: 'test.txt',
      status: 'modified',
      patch: '@@ -1,1 +1,2 @@\n pong\n+abc',
    });
    const entries = deriveSessionReview([first, second, first]);
    expect(entries).toHaveLength(2);
    expect(entries.map(({ added, removed, status }) => ({ added, removed, status }))).toEqual([
      { added: 1, removed: 0, status: 'added' },
      { added: 1, removed: 0, status: 'modified' },
    ]);
    expect(deriveSessionReview([])).toEqual([]);
  });
  it('excludes failed, pending, and unrelated tools', () => {
    const message = reviewMessage('one', { version: 1, path: 'a', status: 'added', patch: '+x' });
    expect(deriveSessionReview([{ ...message, blocks: message.blocks.slice(0, 1) }])).toEqual([]);
    expect(
      deriveSessionReview([
        { ...message, blocks: [message.blocks[0], { ...message.blocks[1], toolOk: false }] },
      ])
    ).toEqual([]);
    expect(
      deriveSessionReview([
        { ...message, blocks: [{ ...message.blocks[0], toolName: 'bash' }, message.blocks[1]] },
      ])
    ).toEqual([]);
  });
  it('labels legacy writes as content previews, not new files', () => {
    const message = reviewMessage('old', { version: 1, path: 'a', status: 'added' });
    message.blocks[1].toolOutput = 'written';
    expect(deriveSessionReview([message])[0]).toMatchObject({
      status: 'unknown',
      preview: { source: 'write-content' },
    });
  });
  it('preserves missing-diff reasons without fabricated counts', () => {
    const message = reviewMessage('large', {
      version: 1,
      path: 'a',
      status: 'modified',
      unavailable: 'too-large',
    });
    expect(deriveSessionReview([message])[0]).toMatchObject({
      unavailable: 'too-large',
      added: 0,
      removed: 0,
    });
  });
});
