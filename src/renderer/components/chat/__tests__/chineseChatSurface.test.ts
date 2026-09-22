// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { applyRuntimeEvent, type ChatBlock, type ChatSessionsState } from '@/stores/chatSessions';
import { deriveChatEmptySurface } from '../chatEmptyState';
import { ModelMissingNotice } from '../ModelMissingNotice';
import { isModelMissingError } from '../modelMissingError';
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
  // ⚠️ REWRITTEN TWICE. T105 (2026-09-19) merged these three into one aggregate
  // row; decision 034 (2026-09-22) deleted the aggregate and they are three
  // rows again — with the past-tense verbs replaced by two-character TYPE
  // LABELS, which is the half this case now protects.
  const rows = deriveToolGroupRows(
    [
      toolRun('Bash', 'ok', { command: 'pnpm test' }),
      toolRun('Grep', 'ok', { pattern: 'TODO' }),
      toolRun('Edit', 'running', { file_path: '/repo/src/a.ts' }),
    ],
    { repoName: 'ai-client', t: zh }
  );
  // Decision 034: three calls are three rows, each wearing its own verb.
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.verb)).toEqual(['Ran', 'Grepped', 'Editing']);

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
    // Type labels, not past-tense verbs: 「终端」 rather than 「已运行」.
    expect(text).toContain('终端');
    expect(text).toContain('搜索');
    // The PRESENT tense is untouched — `Running` / `Editing` are shared with the
    // Run panel, so only the settled side became a type label.
    expect(text).toContain('编辑中');
    // Decision 034 path order: file name first, directory behind it.
    expect(text).toContain('a.ts');
    expect(text).not.toMatch(/tool calls|Editing|Ran|Grepped/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * The single-run path, which is where the per-verb translations actually land
 * now that a multi-call group is one aggregate row: a lone call is still its
 * own row, verb and argument translated exactly as before.
 */
it('renders a lone tool row in Chinese — verb and search arg alike', async () => {
  const rows = deriveToolGroupRows([toolRun('Grep', 'ok', { pattern: 'TODO' })], {
    repoName: 'ai-client',
    t: zh,
  });
  const { container, root } = mount();
  try {
    await act(async () => root.render(createElement(ToolRow, { key: rows[0].key, view: rows[0] })));
    const text = container.textContent ?? '';
    expect(text).toContain('搜索');
    expect(text).not.toContain('已搜索内容');
    // The repo tail is composed inside the derivation, so it proves the `t`
    // threaded through `ToolCardOptions` actually arrived.
    expect(text).toContain('TODO（ai-client）');
    expect(text).not.toMatch(/Grepped|Searching/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * Where a long command lives, after the user moved it twice on 2026-09-22.
 *
 * It used to be the aggregate's DETAIL row: open the aggregate and the whole
 * command was on screen. The ruling 「不想显示那么长…具体的指令内容在展开栏目里
 * 显示」 puts it one level further down — the detail row names the call within
 * `COMMAND_SUMMARY_MAX_CHARS`, and the command itself is behind that row's own
 * disclosure. What has NOT changed is that it must be reachable at all, which
 * is what decision 033 D6 fixed (`command` was marked "covered", so the body
 * was never generated and no number of clicks reached it).
 */
it('keeps a long command off the row, and reachable behind it', async () => {
  const command = `echo ${'long-command-argument-'.repeat(8)}`;
  const rows = deriveToolGroupRows(
    [toolRun('Read', 'ok', { file_path: '/repo/example.ts' }), toolRun('Bash', 'ok', { command })],
    { t: zh }
  );
  const { container, root } = mount();
  try {
    // `rows[1]` is the Bash call — one row per entry since decision 034.
    await act(async () => root.render(createElement(ToolRow, { view: rows[1] })));
    // Decision 034: no aggregate, so the Bash row IS the top-level row. The
    // command is still not on it — the summary is capped — and it is still one
    // click away rather than none, which is what decision 033 D6 restored.
    const trigger = container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!;
    expect(trigger.textContent).toContain('终端');
    expect(container.textContent).not.toContain(command);

    await act(async () => trigger.click());
    expect(container.textContent).toContain(command);
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
    expect(text).toContain('思考');
    expect(text).not.toContain('已思考');
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

/**
 * T023 — the runtime's own permission sentence, rendered.
 *
 * The block below carries only `permissionAction`, which is all the native
 * runtime sends since the four Chinese literals came out of
 * `src/runtime/worker/permissionPrompt.ts`. So this asserts the whole chain in
 * one go: id crosses the worker boundary, `PERMISSION_ACTION_LABELS` words it,
 * the dictionary translates it, and the card paints the result. Before T023
 * the Chinese here came from the worker and the English install had no way to
 * get anything else.
 */
it('renders the runtime permission action from an id, in Chinese', async () => {
  const block = {
    id: 'perm-action',
    type: 'permission_request',
    permissionId: 'perm-action',
    toolName: 'bash',
    permissionAction: 'run_command',
    permissionKind: 'exec',
    permissionDecisions: ['allow', 'deny'],
    toolInput: { command: 'pnpm test', workspace: '/repo' },
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
    expect(text).toContain('在工作区运行命令');
    // The English catalog key must not leak onto a Chinese card — that is the
    // exact failure the mirror-image guard (`toolVocabulary`) was built for.
    expect(text).not.toContain('Run a command in the workspace');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * T067 (D20) — the question card, rendered.
 *
 * Its permission sibling has been asserted above since T023, which is exactly
 * how this one stayed English for so long: same file, same shell, same screen,
 * and no test ever read its DOM. The 2026-09-17 field pass photographed the
 * two cards stacked — 「权限 / 直接允许」 above 「Questions / Skip / Continue」.
 *
 * The negative half is the load-bearing half: every one of these words has a
 * plausible catalog entry, so asserting only the Chinese would pass on a card
 * that still printed the English next to it.
 */
it('renders the interactive question card in Chinese — title, Other row and both buttons', async () => {
  const block = {
    id: 'q1',
    type: 'question',
    questionId: 'q1',
    questions: [{ question: '要先跑哪一套测试？', options: [{ label: '单元测试' }] }],
  } as unknown as ChatBlock;
  const { container, root } = mount();
  try {
    await act(async () =>
      root.render(createElement(QuestionCard, { variant: 'interactive', block }))
    );
    const text = container.textContent ?? '';
    expect(text).toContain('提问');
    expect(text).toContain('其他…');
    expect(text).toContain('跳过');
    expect(text).toContain('继续');
    // The agent's own option label is never translated — it is its words.
    expect(text).toContain('单元测试');
    expect(text).not.toMatch(/Questions|Other…|Skip|Continue/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('renders the frozen question card in Chinese — answered and skipped headers alike', async () => {
  const answered = {
    id: 'q2',
    type: 'question',
    questionId: 'q2',
    resolved: true,
    questionOutcome: 'answered',
    questions: [{ question: '要先跑哪一套测试？', options: [] }],
    questionResponse: '单元测试',
  } as unknown as ChatBlock;
  const skipped = {
    ...answered,
    id: 'q3',
    questionOutcome: 'cancelled',
    questionResponse: undefined,
  } as unknown as ChatBlock;
  const { container, root } = mount();
  try {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(QuestionCard, { key: 'a', variant: 'frozen', block: answered }),
          createElement(QuestionCard, { key: 's', variant: 'frozen', block: skipped })
        )
      )
    );
    const text = container.textContent ?? '';
    expect(text).toContain('回答');
    expect(text).toContain('已跳过提问');
    expect(text).toContain('已跳过');
    expect(text).not.toMatch(/Answers|Questions skipped|Skipped/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * T062 round-2 (2026-09-17 re-verification) — the send path, end to end.
 *
 * The point-check sent into a chat whose recorded model is gone and got an
 * English line under the composer and no recovery card anywhere: the code had
 * reached the renderer, but every H/21 surface was unreachable from a send
 * (see `ModelMissingNotice`'s header for why each one is). This drives the real
 * input — a `session.failed` event carrying the code — through the real
 * reducer, the real surface decision and the real component, with a real `zh`
 * translator, and reads the DOM back.
 */
function stateWithActiveSession(): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [
      {
        id: 'session-1',
        title: 'stale model',
        status: 'running',
      } as ChatSessionsState['sessions'][number],
    ],
    messages: {},
    activeSessionId: 'session-1',
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    runtimeReady: true,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondQuestion: async () => false,
    initRuntime: () => () => {},
  };
}

it('renders the model-missing recovery card in Chinese when a SEND fails (T062)', async () => {
  // Verbatim from the 2026-09-17 run, code and all.
  const diagnostic =
    'model_not_in_catalog: no model "vllmproxy-old/claude-does-not-exist" in the catalog (1 available)';
  const failed: RuntimeEvent = {
    type: 'session.failed',
    seq: 1,
    sessionId: 'session-1',
    timestamp: 1,
    payload: { error: diagnostic },
  };

  const patch = applyRuntimeEvent(stateWithActiveSession(), failed);
  const lastError = patch.lastError ?? null;
  // The chain the composer walks: the event writes `lastError`, `lastError`
  // lights the surface above the composer, and the detector claims it.
  expect(lastError).toBe(diagnostic);
  expect(isModelMissingError(lastError)).toBe(true);
  expect(
    deriveChatEmptySurface({ hasError: Boolean(lastError), hasWorkspace: true, hasCwd: true })
  ).toBe('error-notice');

  const { container, root } = mount();
  try {
    await act(async () => root.render(createElement(ModelMissingNotice, { error: lastError })));
    const text = container.textContent ?? '';
    expect(text).toContain('本应用没有这个模型');
    expect(text).toContain(
      zh(
        'This chat is pinned to a model this app does not have, so it could not be started. This app uses its own agent directory, and AI services you set up in your own Pi directory do not come across on their own.'
      )
    );
    expect(text).toContain('到「设置 · Pi」把 AI 服务迁移或补上');
    expect(text).toContain('去 Pi 设置补上模型');
    // The sentence names WHICH model, which is the one part of the raw
    // diagnostic worth keeping — losing it makes two stale chats identical.
    expect(text).toContain('vllmproxy-old/claude-does-not-exist');
    // Reverse: the dictionary KEYS are what the strip used to print.
    expect(text).not.toContain('Model is not available here');
    expect(text).not.toContain('Migrate or add the AI service');
    expect(text).not.toContain('Add the model in Pi settings');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
