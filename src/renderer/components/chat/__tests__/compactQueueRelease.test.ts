// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectCompactPhase, useCompactRunsStore } from '@/stores/compactRuns';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { createEmptyState, type QueuedMessage } from '../messageQueue';
import { useQueueRelease } from '../useQueueRelease';

/**
 * dsh-rebase decision 178: what was queued while this window's `/compact`
 * ran goes out once it ends — compacted or not — and not before. The
 * composer holds the release on the compaction's phase (`isInFlight`); this
 * pins that wiring and shows the hook doing it.
 */

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useMessageQueueStore.setState({ state: createEmptyState() });
  useCompactRunsStore.setState({ phases: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the queue while /compact runs (decision 178)', () => {
  it('[178-Q-01] the composer holds its queue for the whole /compact, not only its start', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'ChatComposer.tsx'), 'utf8');
    expect(source).toContain(
      'isInFlight: () => inFlightRef.current || stoppingRef.current || compactPhase !== undefined,'
    );
  });

  it('[178-Q-02] holds while it starts and compacts, releases once it ends', async () => {
    const sent: string[] = [];
    const runEntry = vi.fn(async (entry: QueuedMessage) => {
      sent.push(entry.text);
      return 'committed' as const;
    });
    function Harness() {
      // The composer's own reading: the phase of this conversation's `/compact`.
      const phase = useCompactRunsStore((state) => selectCompactPhase(state, 'c1'));
      useQueueRelease({
        sessionId: 'c1',
        hasTarget: true,
        disabled: false,
        sending: false,
        isInFlight: () => phase !== undefined,
        status: 'idle',
        runEntry,
      });
      return null;
    }
    const runs = useCompactRunsStore.getState();
    expect(runs.begin('c1')).toBe(true);
    useMessageQueueStore.getState().enqueue({
      id: 'q1',
      sessionId: 'c1',
      text: 'after the summary',
      attachments: [],
      queuedAt: 1,
    });
    await act(async () => root.render(createElement(Harness)));
    expect(sent).toEqual([]);
    await act(async () => runs.setPhase('c1', 'starting'));
    expect(sent).toEqual([]);
    await act(async () => runs.setPhase('c1', 'compacting'));
    expect(sent).toEqual([]);
    await act(async () => runs.end('c1'));
    expect(sent).toEqual(['after the summary']);
  });

  it('[179-Q-01] a start that fails ends the /compact too: what was queued while it started goes out', async () => {
    const sent: string[] = [];
    const runEntry = vi.fn(async (entry: QueuedMessage) => {
      sent.push(entry.text);
      return 'committed' as const;
    });
    function Harness() {
      const phase = useCompactRunsStore((state) => selectCompactPhase(state, 'c1'));
      useQueueRelease({
        sessionId: 'c1',
        hasTarget: true,
        disabled: false,
        sending: false,
        isInFlight: () => phase !== undefined,
        status: 'idle',
        runEntry,
      });
      return null;
    }
    const runs = useCompactRunsStore.getState();
    expect(runs.begin('c1')).toBe(true);
    await act(async () => runs.setPhase('c1', 'starting'));
    // Decision 179: queued while the conversation was being started.
    useMessageQueueStore.getState().enqueue({
      id: 'q1',
      sessionId: 'c1',
      text: 'sent while it started',
      attachments: [],
      queuedAt: 1,
    });
    await act(async () => root.render(createElement(Harness)));
    expect(sent).toEqual([]);
    // The start failed: the compaction never began, and the `/compact` ended.
    await act(async () => runs.end('c1'));
    expect(sent).toEqual(['sent while it started']);
  });
});
