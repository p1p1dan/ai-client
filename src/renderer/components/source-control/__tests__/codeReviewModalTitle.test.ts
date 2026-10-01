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

const probe = vi.hoisted(() => ({ model: undefined as string | undefined }));

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

  it('[GW6-CHOSEN] still names a chosen model by its id', async () => {
    probe.model = 'claude/claude-sonnet-5-5';
    expect(await title()).toBe('代码审查(claude/claude-sonnet-5-5)');
  });
});
