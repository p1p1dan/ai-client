import { expect, it, vi } from 'vitest';
import { createPiSdkStub } from '../../src/agent-host/__tests__/fixtures/piSdkStub.ts';
import { PiWorkerSession } from '../../src/agent-host/piWorkerSession.ts';
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

it('releases three queued messages through PiWorkerSession after a long Pi turn in strict FIFO', async () => {
  const stub = createPiSdkStub({ manualPrompt: true });
  const runtime = new PiWorkerSession({
    logicalSessionId: 's1',
    cwd: '/repo',
    projectTrusted: false,
    emit: () => undefined,
    log: () => undefined,
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => GATED,
  });
  await runtime.bootstrap();

  await runtime.startSend({
    logicalSessionId: 's1',
    requestId: 'long-turn',
    text: 'long-running turn',
  });
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
  stub.sessionFor('/repo')?.emit({ type: 'agent_settled' });

  let requestSequence = 0;
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
      requestSequence += 1;
      await runtime.startSend({
        logicalSessionId: entry.sessionId,
        requestId: `queued-${requestSequence}`,
        text: entry.text,
        attachments: [...entry.attachments],
      });
      await vi.waitFor(() =>
        expect(stub.sessionFor('/repo')?.prompts).toHaveLength(promptCount + 1)
      );
      stub.finishPrompt('/repo');
      stub.sessionFor('/repo')?.emit({ type: 'agent_settled' });
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
