import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertPiSessionBytes, type DshSeedEvent } from '../index.ts';
import { estimateMessageTokens, shadowedTokenCount } from '../tokenEstimate.ts';

/**
 * dsh-rebase P1-9c — the copy of DSH's heuristic token estimator that prices
 * a compaction's shadowed span (`shadowedTokenCount`) stays DSH's.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const CORPUS = path.join(REPO, 'src/shared/__tests__/fixtures/legacy-pi');
const DSH_ESTIMATE = path.join(
  REPO,
  'src/dsh-host/node_modules/@deepseek-ai/dsh-token-meter/lib/types/estimate.js'
);

type Message = { role: string; content: unknown[] };

const user = (content: unknown[]): Message => ({ role: 'user', content });

/** Every message a converted corpus seed carries, and a few block shapes it does not. */
function samples(): Message[] {
  const manifest = (
    JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8')) as {
      files: Array<{ file: string; sourcePath: string; cwd: string }>;
    }
  ).files;
  const messages: Message[] = [];
  for (const entry of manifest) {
    const result = convertPiSessionBytes(readFileSync(path.join(CORPUS, entry.file)), {
      sourceFile: entry.sourcePath,
      cwd: entry.cwd,
    });
    if (!result.ok) continue;
    for (const event of result.seed as DshSeedEvent[]) {
      const data = event.data as Record<string, unknown>;
      const message = event.type === 'user/message' ? data : data?.message;
      if (message && typeof message === 'object') messages.push(message as Message);
    }
  }
  messages.push(
    { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
    { role: 'system', content: [{ type: 'file', attachment: { attachmentId: 'f', name: 'n' } }] },
    user([
      {
        type: 'image',
        attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        offloaded: true,
      },
    ]),
    user([{ type: 'file', attachment: { attachmentId: 'f', name: 'notes.txt', bytes: 3 } }])
  );
  return messages;
}

describe('the vendored token estimator', () => {
  it('prices text, calls, structure and the system prompt the way DSH does', () => {
    // ceil(5 / 4) + 4 for the block, + 4 for the role.
    expect(estimateMessageTokens(user([{ type: 'text', text: 'abcde' }]))).toBe(10);
    expect(
      estimateMessageTokens({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'abcd' },
          { type: 'tool-call', id: 'c', name: 'read', arguments: '{"path":"a"}' },
        ],
      })
    ).toBe(1 + 4 + (1 + 3 + 4) + 4);
    expect(estimateMessageTokens({ role: 'system', content: [] })).toBe(0);
    expect(
      estimateMessageTokens({ role: 'system', content: [{ type: 'text', text: 'abcde' }] })
    ).toBe(2 + 4);
    // An image reference is priced as its JSON, the offload mark left out.
    const image = { type: 'image', attachment: { attachmentId: 'a' } };
    expect(estimateMessageTokens(user([{ ...image, offloaded: true }]))).toBe(
      estimateMessageTokens(user([image]))
    );
  });

  it('sums a shadowed span over the messages its events carry', () => {
    const events: DshSeedEvent[] = [
      {
        type: 'user/message',
        seq: 0,
        time: 0,
        data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'abcde' }] },
      },
      {
        type: 'assistant/message',
        seq: 1,
        time: 0,
        data: { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'ab' }] } },
      },
    ];
    expect(shadowedTokenCount(events, [0, 1])).toBe(10 + 9);
  });
});

/** Only where src/dsh-host is installed, as forkSeed.test.ts does for its copy. */
describe.skipIf(!existsSync(DSH_ESTIMATE))('the vendored token estimator against DSH', () => {
  it('prices every message of every corpus seed as dsh-token-meter does', async () => {
    const dsh = (await import(pathToFileURL(DSH_ESTIMATE).href)) as {
      estimateMessage(message: unknown): number;
    };
    const messages = samples();
    expect(messages.length).toBeGreaterThan(200);
    const differing = messages.filter(
      (message) => estimateMessageTokens(message) !== dsh.estimateMessage(message)
    );
    expect(differing).toEqual([]);
  });
});
