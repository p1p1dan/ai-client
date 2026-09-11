// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { PermissionActivityRows } from '../PermissionActivityRows';
import { QuestionCard } from '../QuestionCard';
import { ToolRow } from '../ToolRows';
import { deriveToolGroupRows, type ToolGroupEntry } from '../toolCard';

/**
 * The end-to-end half of the language guard: not "does the catalog have the
 * word" (`toolVocabulary.test.ts` asks that) but "does the word on screen come
 * from the catalog".
 *
 * Both are needed, and neither substitutes for the other. The 2026-09-11 field
 * report found a transcript that read 「Grepped src · Allowed」in a Chinese UI
 * — every one of those words had a plausible entry available; the render path
 * simply never asked for one. A test that only checked the table would have
 * been green the whole time.
 *
 * So this one drives the real components with a real `zh` translator and reads
 * the DOM back.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  return { container, root: createRoot(container) };
}

function toolRun(
  toolName: string,
  status: 'running' | 'ok',
  input: Record<string, unknown>
): ToolGroupEntry {
  return {
    kind: 'run',
    run: {
      toolCallId: `call-${toolName}-${status}`,
      blockIndex: 0,
      blockId: `block-${toolName}-${status}`,
      toolName,
      input,
      status,
      ...(status === 'ok' ? { output: 'done' } : {}),
    },
  };
}

it('renders tool rows in Chinese — the verb, the running verb and the search arg', async () => {
  // Bash and Grep stay standalone rows (action / permissioned classes never
  // aggregate), and a running call always ends the aggregatable prefix, so
  // these three arrive as three separate rows with their own verbs.
  const rows = deriveToolGroupRows(
    [
      toolRun('Bash', 'ok', { command: 'pnpm test' }),
      toolRun('Grep', 'ok', { pattern: 'TODO' }),
      toolRun('Edit', 'running', { file_path: '/repo/src/a.ts' }),
    ],
    { repoName: 'ai-client', t: zh }
  );
  const { container, root } = mount();
  try {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          ...rows.map((view) => createElement(ToolRow, { key: view.key, view }))
        )
      )
    );
    const text = container.textContent ?? '';
    expect(text).toContain('已运行');
    expect(text).toContain('已搜索内容');
    expect(text).toContain('编辑');
    // The repo tail is composed inside the derivation, so it proves the `t`
    // threaded through `ToolCardOptions` actually arrived.
    expect(text).toContain('TODO（ai-client）');
    expect(text).not.toMatch(/Ran|Grepped|Editing/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('renders a thought row in Chinese, duration and all', async () => {
  const rows = deriveToolGroupRows(
    [
      {
        kind: 'thinking',
        block: { id: 'th', type: 'thinking', text: 'weighing it' },
        blockIndex: 0,
      },
    ],
    { t: zh, thinkingDurationMs: () => 66_000 }
  );
  const { container, root } = mount();
  try {
    await act(async () => root.render(createElement(ToolRow, { view: rows[0] })));
    const text = container.textContent ?? '';
    expect(text).toContain('已思考');
    expect(text).toContain('耗时 1m 6s');
    expect(text).not.toContain('Thought');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('renders the approval audit rows in Chinese', async () => {
  const blocks: ChatBlock[] = [
    { requestId: 'pending', surface: 'bash', value: 'rm -rf /tmp/x' },
    { requestId: 'denied', surface: 'bash', result: 'deny' as const, value: 'curl evil.test' },
    {
      requestId: 'auto',
      surface: 'read',
      result: 'allow' as const,
      resolution: 'policy_allow',
      matchedPattern: 'src/**',
    },
  ].map((permissionActivity) => ({
    id: permissionActivity.requestId,
    type: 'permission_activity',
    permissionActivity,
  }));
  const { container, root } = mount();
  try {
    await act(async () =>
      root.render(createElement(PermissionActivityRows, { blocks, includeAllowed: true }))
    );
    const text = container.textContent ?? '';
    expect(text).toContain('等待审批');
    expect(text).toContain('已拒绝');
    expect(text).toContain('策略放行');
    expect(text).toContain('命中规则 src/**');
    // The plugin's own identifiers pass through untranslated, by design.
    expect(text).toContain('bash');
    expect(text).not.toMatch(/Awaiting approval|Denied|policy allow/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('renders the permission card in Chinese — title, risk chip, body label and buttons', async () => {
  const block = {
    id: 'perm',
    type: 'permission_request',
    permissionId: 'perm',
    toolName: 'write',
    toolDescription: '写入 notes.md',
    permissionKind: 'file_change',
    permissionDecisions: ['allow', 'allow_session', 'deny', 'cancel'],
    toolInput: { content: 'hello', contentLabel: 'Content', workspace: '/repo' },
  } as unknown as ChatBlock;
  const { container, root } = mount();
  try {
    await act(async () =>
      root.render(
        createElement(QuestionCard, {
          variant: 'permission',
          block,
          canRespond: true,
          onRespondPermission: async () => true,
        })
      )
    );
    const text = container.textContent ?? '';
    expect(text).toContain('权限');
    expect(text).toContain('高风险');
    expect(text).toContain('内容');
    expect(text).toContain('项目：/repo');
    for (const label of ['直接允许', '本会话内允许', '直接拒绝', '拒绝并停止']) {
      expect(text).toContain(label);
    }
    expect(text).not.toMatch(/Permission|Allow for session|Deny and stop|High risk/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
