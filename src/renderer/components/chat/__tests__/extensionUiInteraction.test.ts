// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { ExtensionUiInlineDock } from '../ExtensionUiDialog';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
it('retains a failed answer, supports retry, and cancels the next queued request with Escape', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const respond = vi
    .fn()
    .mockRejectedValueOnce(new Error('IPC failed'))
    .mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', { chat: { respondExtensionUi: respond } });
  const pending = [1, 2].map((id) => ({
    sessionId: 's',
    runtimeId: 'r',
    uiRequestId: `q${id}`,
    receivedAt: 0,
    dialog: {
      method: 'select' as const,
      title: 'Question\n\nLong preview',
      options: ['Long option '.repeat(40), 'Other'],
    },
  }));
  useExtensionUiStore.setState({ pending, sending: [], sendErrors: {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExtensionUiInlineDock, { sessionId: 's' })));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="group"] button')!.click()
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('IPC failed');
    expect(useExtensionUiStore.getState().pending).toHaveLength(2);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="group"] button')!.click()
    );
    expect(useExtensionUiStore.getState().pending[0].uiRequestId).toBe('q2');
    await act(async () =>
      container
        .querySelector('section')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(useExtensionUiStore.getState().pending).toHaveLength(0);
    expect(respond).toHaveBeenLastCalledWith({ runtimeId: 'r', uiRequestId: 'q2', ok: false });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
