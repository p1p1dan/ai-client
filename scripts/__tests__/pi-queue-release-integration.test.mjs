import { expect, it, vi } from 'vitest';
import { createPiSdkStub } from '../../src/agent-host/__tests__/fixtures/piSdkStub.ts';
import { PiAgentRuntime } from '../../src/agent-host/piRuntime.ts';
import { SessionRegistry } from '../../src/agent-host/sessionRegistry.ts';
import {
  createEmptyState,
  enqueue,
  pauseSession,
  restoreHead,
  selectSessionQueue,
  takeHead,
} from '../../src/renderer/components/chat/messageQueue.ts';
import { releaseQueueHead } from '../../src/renderer/components/chat/queueReleaseTransaction.ts';

const GATED = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

it('releases three queued messages through PiAgentRuntime after a long Pi turn in strict FIFO', async () => {
  const stub = createPiSdkStub({ manualPrompt: true });
  const runtime = new PiAgentRuntime({
    registry: new SessionRegistry(),
    emit: () => undefined,
    log: () => undefined,
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => GATED,
  });
  runtime.createSession({ sessionId: 's1', workspacePath: '/repo' });

  const longTurn = runtime.send({ sessionId: 's1', text: 'long-running turn' });
  await vi.waitFor(() => expect(stub.sessionFor('/repo')?.prompts).toHaveLength(1));

  const queued = [
    {
      id: 'q1',
      sessionId: 's1',
      text: 'first queued',
      attachments: [
        {
          id: 'a1',
          kind: 'text',
          mediaType: 'text/plain',
          name: 'note.txt',
          byteLength: 5,
          data: 'hello',
        },
      ],
      queuedAt: 1,
    },
    { id: 'q2', sessionId: 's1', text: 'second queued', attachments: [], queuedAt: 2 },
    { id: 'q3', sessionId: 's1', text: 'third queued', attachments: [], queuedAt: 3 },
  ];
  let state = createEmptyState();
  for (const entry of queued) {
    const result = enqueue(state, entry);
    if (!result.ok) throw new Error(result.message);
    state = result.state;
  }

  stub.finishPrompt('/repo');
  await longTurn;

  const operations = {
    takeHead: (sessionId) => {
      const result = takeHead(state, sessionId);
      state = result.state;
      return result.entry;
    },
    restoreHead: (entry) => {
      state = restoreHead(state, entry);
    },
    pauseRejected: (sessionId) => {
      state = pauseSession(state, sessionId, 'send-rejected');
    },
    runEntry: async (entry) => {
      const promptCount = stub.sessionFor('/repo')?.prompts.length ?? 0;
      const send = runtime.send({
        sessionId: entry.sessionId,
        text: entry.text,
        attachments: [...entry.attachments],
      });
      await vi.waitFor(() =>
        expect(stub.sessionFor('/repo')?.prompts).toHaveLength(promptCount + 1)
      );
      stub.finishPrompt('/repo');
      await send;
      return 'committed';
    },
  };

  await releaseQueueHead('s1', operations);
  await releaseQueueHead('s1', operations);
  await releaseQueueHead('s1', operations);

  expect(stub.sessionFor('/repo')?.prompts.map((prompt) => prompt.text)).toEqual([
    'long-running turn',
    'first queued\n\n--- note.txt ---\nhello',
    'second queued',
    'third queued',
  ]);
  expect(selectSessionQueue(state, 's1').entries).toEqual([]);
});
