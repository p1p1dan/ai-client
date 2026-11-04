// @vitest-environment happy-dom
/**
 * Decision 209 §2: an Outputs row opens its file — a web page in the preview
 * window, anything else in the editor — and a file that is gone says so
 * instead of opening an empty tab. Right-click copies the path or reveals it.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSessionRailStore } from '@/stores/sessionRail';
import { OutputsCard } from '../sessionRail/OutputsCard';
import type { OutputRow } from '../sessionRail/outputsModel';

const api = vi.hoisted(() => {
  const present = new Set<string>();
  const file = {
    exists: async (path: string) => present.has(path),
    revealInFileManager: async (_path: string) => undefined,
  };
  const preview = {
    openHtml: async (_path: string) => ({ ok: true }) as { ok: boolean; reason?: string },
  };
  window.electronAPI = {
    env: { platform: 'linux' },
    file,
    preview,
  } as unknown as typeof window.electronAPI;
  return { present, file, preview };
});
const toasts = vi.hoisted(() => [] as { type?: string; title: string; description?: string }[]);
vi.mock('@/components/ui/toast', () => ({
  toastManager: { add: (toast: { type?: string; title: string }) => toasts.push(toast) },
}));
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const ROWS: OutputRow[] = [
  { key: 'w', path: 'docs/options.html', name: 'options.html', kind: 'web' },
  { key: 'd', path: '/repo/docs/208.md', name: '208.md', kind: 'document' },
];

let root: Root | null = null;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useSessionRailStore.setState({ shown: true, cardOpen: {} });
  useFileOpenIntentStore.setState({ intent: null, sequence: 0 });
  api.present.clear();
  toasts.length = 0;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(createElement(OutputsCard, { rows: ROWS, workspacePath: '/repo' }))
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function row(kind: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-output-kind="${kind}"]`);
  if (!button) throw new Error(`no ${kind} row`);
  return button;
}

describe('OutputsCard', () => {
  it('a row shows the icon and the name, the full path on hover', () => {
    expect(document.querySelector('[data-rail-card="outputs"]')?.textContent).toContain('产出');
    expect(row('web').textContent).toBe('options.html');
    expect(row('web').title).toBe('/repo/docs/options.html');
    expect(row('document').title).toBe('/repo/docs/208.md');
    expect(row('web').querySelector('svg')).not.toBeNull();
  });

  it('a web page opens in the preview window, at its absolute path', async () => {
    api.present.add('/repo/docs/options.html');
    const openHtml = vi.spyOn(api.preview, 'openHtml');
    await act(async () => row('web').click());
    expect(openHtml).toHaveBeenCalledWith('/repo/docs/options.html');
    expect(useFileOpenIntentStore.getState().intent).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('a document opens in the editor through the file-open request', async () => {
    api.present.add('/repo/docs/208.md');
    await act(async () => row('document').click());
    expect(useFileOpenIntentStore.getState().intent).toMatchObject({
      path: '/repo/docs/208.md',
      source: 'outputs',
    });
  });

  it('a file that is gone says so and opens nothing', async () => {
    const openHtml = vi.spyOn(api.preview, 'openHtml');
    await act(async () => row('document').click());
    await act(async () => row('web').click());
    expect(useFileOpenIntentStore.getState().intent).toBeNull();
    expect(openHtml).not.toHaveBeenCalled();
    expect(toasts.map((toast) => toast.title)).toEqual(['文件已不在', '文件已不在']);
  });

  it('right-click: copy the path, or show it in the file manager', async () => {
    const reveal = vi.spyOn(api.file, 'revealInFileManager');
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await act(async () => {
      row('document').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    const copy = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (item) => item.textContent?.includes(zh('Copy Path'))
    );
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith('/repo/docs/208.md');

    await act(async () => {
      row('document').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    const show = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (item) => item.textContent?.includes(zh('Reveal in Explorer'))
    );
    await act(async () => show?.click());
    expect(reveal).toHaveBeenCalledWith('/repo/docs/208.md');
  });
});
