// @vitest-environment happy-dom
/**
 * dsh-rebase decision 146 (GW-6), rendered: the code review dialog's title
 * names the model choice. Automatic mode stores no model id, and the title
 * used to read 「代码审查()」 — empty brackets. It now says 「自动」, the word
 * the AI settings page uses for the same choice; a chosen model still shows
 * its id.
 *
 * Everything the title does not need is stubbed: the review hook and store
 * (idle, no content), the settings store (just `codeReview`), and the two
 * heavy renderers the markdown body would pull in.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  model: undefined as string | undefined,
  catalog: null as { models: { id: string; label: string }[] } | null,
  catalogReads: 0,
}));

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/utils/logging', () => ({ updateRendererLogging: () => {} }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh, locale: 'zh' }) }));
vi.mock('@/stores/settings', () => {
  const state = () => ({
    codeReview: { enabled: true, language: 'zh', prompt: '', model: probe.model },
  });
  return {
    useSettingsStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state }
    ),
  };
});
vi.mock('@/hooks/useCodeReview', () => ({
  useCodeReview: () => ({
    content: '',
    status: 'idle',
    error: null,
    startReview: () => undefined,
    reset: () => undefined,
  }),
}));
vi.mock('@/stores/codeReview', () => {
  const state = {
    review: { repoPath: null },
    isMinimized: false,
    minimize: () => undefined,
    restore: () => undefined,
  };
  return {
    useCodeReviewStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
    stopCodeReview: () => undefined,
  };
});
vi.mock('@/components/ui/mermaid-renderer', () => ({ MermaidRenderer: () => null }));
// Decision 156: the title reads a chosen model's label from the catalog cache.
vi.mock('@/components/chat/usePiModelCatalog', () => ({
  usePiModelCatalog: () => {
    probe.catalogReads += 1;
    return { catalog: probe.catalog };
  },
}));
vi.mock('@/components/ui/code-block', () => ({ CodeBlock: () => null }));

import { CodeReviewModal } from '../CodeReviewModal';

let root: Root | undefined;

async function title(): Promise<string> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(CodeReviewModal, { open: true, onOpenChange: () => {}, repoPath: '/repo' })
    )
  );
  const heading = document.body.querySelector('[data-slot="dialog-title"]');
  expect(heading, 'the dialog title').not.toBeNull();
  return heading?.textContent ?? '';
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  probe.model = undefined;
  probe.catalog = null;
  probe.catalogReads = 0;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the code review dialog title (decision 146, GW-6)', () => {
  it('[GW6-AUTO] says 「自动」 in automatic mode, never empty brackets', async () => {
    const text = await title();
    expect(text).toBe('代码审查(自动)');
    expect(text).not.toContain('()');
  });

  it('[GW6-AUTO-EMPTY] treats an empty model id as automatic too', async () => {
    probe.model = '';
    expect(await title()).toBe('代码审查(自动)');
  });

  it('[GW6-CHOSEN] names a chosen model the catalog does not list by its id', async () => {
    probe.model = 'claude/claude-sonnet-5-5';
    expect(await title()).toBe('代码审查(claude/claude-sonnet-5-5)');
  });

  // Decision 156 (decision 146 GW-6's second half): by its label, as the
  // model menu and the AI settings page name it.
  it('[E156-11] names a chosen model by its catalog label', async () => {
    probe.model = 'claude/claude-sonnet-5-5';
    probe.catalog = {
      models: [
        { id: 'claude/claude-opus-5', label: 'Claude Opus 5' },
        { id: 'claude/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      ],
    };
    expect(await title()).toBe('代码审查(Claude Sonnet 5.5)');
  });

  it('[E156-11-AUTO] reads no catalog in automatic mode', async () => {
    probe.catalog = { models: [{ id: 'x', label: 'X' }] };
    expect(await title()).toBe('代码审查(自动)');
    expect(probe.catalogReads).toBe(0);
  });
});
