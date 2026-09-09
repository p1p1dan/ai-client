// @vitest-environment happy-dom

import type { PiUsagePayload } from '@shared/piUsage';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { ComposerUsageChip, currentTurnToolSummary } from '../ComposerUsageChip';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params?.[name] ?? name)),
  }),
}));
const usage: PiUsagePayload = {
  input: 20000,
  output: 79,
  cacheRead: 128,
  cacheWrite: 0,
  totalTokens: 20207,
  costUsd: 0,
  context: { tokens: 21000, contextWindow: 500000, percent: 4.2 },
  session: {
    turns: 3,
    toolResults: 0,
    input: 40000,
    output: 200,
    cacheRead: 128,
    cacheWrite: 0,
    totalTokens: 40328,
    costUsd: 0,
  },
};
it('opens richer details on keyboard focus at the existing chip and drops them on session change', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSessionRuntimeFactsStore.setState({ factsBySession: { s: { usage } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sessionId: string) => {
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          { delay: 0 },
          createElement(ComposerUsageChip, { sessionId })
        )
      )
    );
  };
  try {
    await render('s');
    expect(container.textContent).toBe('4%');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.focus();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const details = document.querySelector('[data-context-details]')!;
    expect(details.textContent).toContain('479.0k tokens remaining');
    expect(details.textContent).toContain('96%');
    expect(details.textContent).toContain('Latest settled model request');
    expect(details.textContent).toContain('Cache hit rate');
    expect(details.textContent).toContain('Conversation total since load');
    expect(details.textContent).toContain('No tool calls');
    await render('empty');
    expect(container.textContent).toBe('');
    expect(document.querySelector('[data-context-details]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
it('counts only current-turn tools instead of reporting estimated tool tokens', () => {
  expect(
    currentTurnToolSummary([
      {
        id: 'old',
        sessionId: 's',
        role: 'assistant',
        blocks: [{ id: 'oldtool', type: 'tool_call', toolName: 'bash' }],
      },
      { id: 'u', sessionId: 's', role: 'user', blocks: [] },
      {
        id: 'a',
        sessionId: 's',
        role: 'assistant',
        blocks: [
          { id: '1', type: 'tool_call', toolName: 'read' },
          { id: '2', type: 'tool_call', toolName: 'read' },
        ],
      },
    ])
  ).toBe('read × 2');
});
