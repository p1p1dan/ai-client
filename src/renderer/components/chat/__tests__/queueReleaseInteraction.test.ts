// @vitest-environment happy-dom
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { createEmptyState, type QueuedMessage, selectSessionQueue } from '../messageQueue';
import { useQueueRelease } from '../useQueueRelease';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useMessageQueueStore.setState({ state: createEmptyState() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('releases after Stop settles idle without Resume, and never sends during cancellation', async () => {
  const sent: string[] = [];
  let status: SessionRuntimeStatus = 'running';
  let stopping = false;
  const runEntry = vi.fn(async (entry: QueuedMessage) => {
    sent.push(entry.id);
    status = 'running';
    return 'committed' as const;
  });
  function Harness() {
    useQueueRelease({
      sessionId: 'a',
      hasTarget: true,
      disabled: stopping,
      sending: false,
      isInFlight: () => stopping,
      status,
      runEntry,
    });
    return null;
  }
  async function render() {
    await act(async () => root.render(createElement(Harness)));
  }
  const store = useMessageQueueStore.getState();
  store.enqueue({ id: 'q1', sessionId: 'a', text: 'first', attachments: [], queuedAt: 1 });
  store.enqueue({ id: 'q2', sessionId: 'a', text: 'second', attachments: [], queuedAt: 2 });
  store.enqueue({ id: 'other', sessionId: 'b', text: 'other chat', attachments: [], queuedAt: 3 });
  await render();
  expect(sent).toEqual([]);
  stopping = true;
  status = 'idle';
  await render();
  expect(sent).toEqual([]);
  stopping = false;
  status = 'stopping';
  await render();
  expect(sent).toEqual([]);
  status = 'idle';
  await render();
  expect(sent).toEqual(['q1']);
  status = 'completed';
  await render();
  expect(sent).toEqual(['q1', 'q2']);
  expect(selectSessionQueue(useMessageQueueStore.getState().state, 'b').entries[0].id).toBe(
    'other'
  );
});
