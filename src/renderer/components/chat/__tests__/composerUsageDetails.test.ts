// @vitest-environment happy-dom

import type { PiUsagePayload } from '@shared/piUsage';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import {
  ComposerUsageChip,
  ComposerUsageDetails,
  currentTurnToolSummary,
} from '../ComposerUsageChip';

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
it('toggles the richer details from the chip button and drops them on session change', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSessionRuntimeFactsStore.setState({ factsBySession: { s: { usage } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sessionId: string) => {
    await act(async () => root.render(createElement(ComposerUsageChip, { sessionId })));
  };
  // The chip is a click target now, so the test drives it the way a user does.
  // happy-dom fires no pointer events from `.click()`, and Base UI's trigger
  // opens on pointerdown, so both go out here.
  const pressChip = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0 }));
      trigger.click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  };
  try {
    await render('s');
    expect(container.textContent).toBe('4%');
    // Closed by default — the details only exist once the chip is pressed.
    expect(document.querySelector('[data-context-details]')).toBeNull();

    await pressChip();
    const details = document.querySelector('[data-context-details]')!;
    expect(details.textContent).toContain('479.0k tokens remaining');
    expect(details.textContent).toContain('96%');
    expect(details.textContent).toContain('Latest settled model request');
    expect(details.textContent).toContain('Cache hit rate');
    expect(details.textContent).toContain('Conversation total since load');
    expect(details.textContent).toContain('No tool calls');

    await pressChip();
    expect(document.querySelector('[data-context-details]')).toBeNull();

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
it('T125: says the cost is unknown instead of printing a cut request as free', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unreported: PiUsagePayload = {
    ...usage,
    input: 0,
    output: 0,
    cacheRead: 0,
    totalTokens: 0,
    unreported: true,
  };
  try {
    await act(async () =>
      root.render(createElement(ComposerUsageDetails, { usage: unreported, tools: '' }))
    );
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-usage-unreported]')).not.toBeNull();
    expect(text).toContain('Usage for this request is unknown');
    // The zero rows are gone, not merely joined by the note.
    expect(text).not.toContain('Input tokens');
    expect(text).not.toContain('Cache hit rate');
    // The occupancy and the session total are still measurements.
    expect(text).toContain('479.0k tokens remaining');
    expect(text).toContain('Conversation total since load');

    await act(async () => root.render(createElement(ComposerUsageDetails, { usage, tools: '' })));
    expect(container.querySelector('[data-usage-unreported]')).toBeNull();
    expect(container.textContent).toContain('Input tokens');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
