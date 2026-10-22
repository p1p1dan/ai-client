// @vitest-environment happy-dom
/**
 * The Servers card (user, 2026-10-22) mounted with its reader: running jobs'
 * output is read from where it left off, an address split across two reads is
 * still found, and a row opens its address in the browser.
 */
import { translate } from '@shared/i18n';
import type { DshJobSummary } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionRailStore } from '@/stores/sessionRail';
import { ServersCard } from '../sessionRail/ServersCard';
import { useJobServers } from '../sessionRail/useJobServers';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const chunks = ['> vite\n  Local:   http://local', 'host:5173/\n'];
const readSessionJob = vi.fn(async ({ from }: { from?: number }) => {
  const at = from ?? 0;
  const index = at === 0 ? 0 : at === chunks[0].length ? 1 : -1;
  if (index < 0) return { text: '', from: at, next: at, omittedBytes: 0, lossy: false };
  return {
    text: chunks[index],
    from: at,
    next: at + chunks[index].length,
    omittedBytes: 0,
    lossy: false,
  };
});
const openExternal = vi.fn(async () => undefined);

const JOBS: DshJobSummary[] = [
  {
    id: 'bash-1',
    kind: 'bash',
    label: 'pnpm dev',
    status: 'running',
    startedAt: 1,
  } as DshJobSummary,
];

function Harness({ jobs }: { jobs: DshJobSummary[] }) {
  const rows = useJobServers('s1', jobs, true);
  return rows.length > 0 ? createElement(ServersCard, { rows }) : null;
}

let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.electronAPI = {
    chat: { readSessionJob },
    shell: { openExternal },
  } as unknown as typeof window.electronAPI;
  useSessionRailStore.setState({ shown: true, cardOpen: {} });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ServersCard with useJobServers', () => {
  it('finds an address split across two reads, then opens it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { jobs: JOBS })));
    expect(container.textContent).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(readSessionJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ jobId: 'bash-1', from: 0 })
    );
    expect(readSessionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ from: chunks[0].length })
    );
    const row = container.querySelector<HTMLButtonElement>('[data-server-url]');
    expect(row?.dataset.serverUrl).toBe('http://localhost:5173/');
    expect(container.textContent).toContain('服务');
    expect(container.textContent).toContain('localhost:5173/');
    expect(container.textContent).toContain('pnpm dev');

    await act(async () => row?.click());
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('a finished job takes its address away and stops being read', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { jobs: JOBS })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.querySelector('[data-server-url]')).not.toBeNull();

    const finished = [{ ...JOBS[0], status: 'completed' }] as DshJobSummary[];
    await act(async () => root?.render(createElement(Harness, { jobs: finished })));
    expect(container.querySelector('[data-server-url]')).toBeNull();
    const calls = readSessionJob.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(readSessionJob.mock.calls.length).toBe(calls);
  });
});
