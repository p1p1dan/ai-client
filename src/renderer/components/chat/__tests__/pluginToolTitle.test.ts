// @vitest-environment happy-dom
/**
 * dsh-rebase decision 131 (decision 073 rule 1, decision 120 item 27, user
 * ruling in decision 130): a plugin tool's row reads by the title the plugin
 * declares for the call (`presentCall`, carried as `presentation` on
 * `tool.started` / `tool.updated` and on the history's `tool_call` block).
 *
 * Three layers, one file: the store keeps the title on the block, the row
 * model prefers it for any tool that is not one of DSH's own (table-driven),
 * and the DOM paints it verbatim where the verb and the argument would be.
 */
import type { ToolCallPresentation } from '@shared/dshToolPresentation';
import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatBlock,
  type ChatMessage,
  type ChatSessionsState,
} from '@/stores/chatSessions';
import { resetResumeCandidatesForTests } from '@/stores/historyReplayMerge';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import {
  deriveToolGroupRows,
  deriveToolRowView,
  pairToolBlocks,
  pluginToolPresentation,
  presentedIconKind,
  type ToolIconKind,
  type ToolRun,
} from '../toolCard';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const CREATE: ToolCallPresentation = {
  card: 'generic',
  title: 'Create docs/report.docx',
  kind: 'edit',
};
const READ: ToolCallPresentation = {
  card: 'generic',
  title: 'Read docs/report.docx',
  kind: 'read',
};

function run(
  toolName: string,
  input: unknown,
  presentation?: ToolCallPresentation,
  overrides: Partial<ToolRun> = {}
): ToolRun {
  return {
    toolCallId: `call-${toolName}`,
    blockIndex: 0,
    blockId: `block-${toolName}`,
    toolName,
    input,
    status: 'ok',
    output: 'done',
    ...(presentation ? { presentation } : {}),
    ...overrides,
  };
}

interface RowCase {
  name: string;
  run: ToolRun;
  /** The plugin's title painted in place of verb + argument, or none. */
  title: string | undefined;
  verb: string;
  icon: ToolIconKind;
  arg: string | undefined;
}

const OFFICE_INPUT = { path: '/w/docs/report.docx', title: 'Q3' };

const ROWS: RowCase[] = [
  {
    name: 'an office write reads by its own title, with the edit mark',
    run: run('word_create', OFFICE_INPUT, CREATE),
    title: 'Create docs/report.docx',
    verb: 'Edited',
    icon: 'edit',
    arg: undefined,
  },
  {
    name: 'an office read reads by its own title, with the file mark',
    run: run('word_read', { path: '/w/docs/report.docx' }, READ),
    title: 'Read docs/report.docx',
    verb: 'Read',
    icon: 'read',
    arg: undefined,
  },
  {
    name: 'reverse: an office call with no title keeps P1-7c’s words (plugin off, older session)',
    run: run('word_create', OFFICE_INPUT),
    title: undefined,
    verb: 'Edited',
    icon: 'edit',
    arg: 'docs/report.docx',
  },
  {
    name: 'an unregistered plugin tool reads by its title; its category picks the mark',
    run: run(
      'acme_fetch',
      { url: 'https://x' },
      { card: 'generic', title: 'Fetch x', kind: 'fetch' }
    ),
    title: 'Fetch x',
    verb: 'Used tool',
    icon: 'web',
    arg: undefined,
  },
  {
    name: 'a category that says nothing keeps the tool’s own mark',
    run: run('acme_widget', {}, { card: 'generic', title: 'Spin the widget', kind: 'other' }),
    title: 'Spin the widget',
    verb: 'Used tool',
    icon: 'tool',
    arg: undefined,
  },
  {
    name: 'reverse: an unregistered tool with no title keeps the fallback 「工具」 + its name',
    run: run('acme_widget', {}),
    title: undefined,
    verb: 'Used tool',
    icon: 'tool',
    arg: 'acme_widget',
  },
  {
    name: 'a plugin command (terminal card) reads as a shell row: 「终端」 + the command',
    run: run(
      'acme_shell',
      { cmd: 'x' },
      { card: 'terminal', title: 'cd /w/app && npm test', description: 'Run tests' }
    ),
    title: undefined,
    verb: 'Ran',
    icon: 'terminal',
    arg: 'npm test',
  },
  {
    name: 'a plugin file change (diff card) reads by its title, with the edit mark',
    run: run('acme_patch', {}, { card: 'diff', title: 'Write notes.md' }),
    title: 'Write notes.md',
    verb: 'Used tool',
    icon: 'edit',
    arg: undefined,
  },
  {
    name: 'reverse: DSH’s own shell keeps P1-7c’s row whatever it was handed',
    run: run('bash', { command: 'ls -la' }, { card: 'terminal', title: 'ls -la' }),
    title: undefined,
    verb: 'Ran',
    icon: 'terminal',
    arg: 'ls -la',
  },
  {
    name: 'reverse: DSH’s own read keeps P1-7c’s row whatever it was handed',
    run: run(
      'read',
      { file_path: '/w/src/a.ts' },
      { card: 'generic', title: 'Read a.ts', kind: 'read' }
    ),
    title: undefined,
    verb: 'Read',
    icon: 'read',
    arg: 'src/a.ts',
  },
];

describe('the row model prefers a plugin’s own title (decision 131)', () => {
  it.each(ROWS)('$name', ({ run: call, title, verb, icon, arg }) => {
    const view = deriveToolRowView(call, { t: zh });
    expect(view.title).toBe(title);
    expect(view.verb).toBe(verb);
    expect(view.iconKind).toBe(icon);
    expect(view.arg).toBe(arg);
  });

  it('[D131-ROW-STATES] the title stands in every state; the outcome and the decision still follow it', () => {
    const running = deriveToolRowView(
      run('word_create', OFFICE_INPUT, CREATE, { status: 'running', output: undefined })
    );
    expect(running).toMatchObject({ title: 'Create docs/report.docx', running: true });
    expect(running.verb).toBe('Editing');
    const refused = deriveToolRowView(
      run('word_create', OFFICE_INPUT, CREATE, {
        permission: {
          id: 'p1',
          type: 'permission_request',
          permissionId: 'call-word_create',
          resolved: true,
          allowed: false,
        },
      })
    );
    expect(refused).toMatchObject({ title: 'Create docs/report.docx', verb: 'Edit' });
    expect(refused.permissionVerb).toBeDefined();
    const notRun = deriveToolRowView(
      run('word_create', OFFICE_INPUT, CREATE, {
        status: 'failed',
        result: { content: [], details: { notStarted: true } },
      })
    );
    expect(notRun).toMatchObject({ title: 'Create docs/report.docx', outcome: 'notStarted' });
  });

  it('[D131-ROW-BODY] the arguments stay one click away: a write still opens onto what it writes', () => {
    const view = deriveToolRowView(run('word_create', OFFICE_INPUT, CREATE));
    expect(view.expandable).toBe(true);
    expect(view.input).toContain('"title": "Q3"');
  });

  it('[D131-ROW-GUARD] an empty title is no title; the category mark table covers every kind', () => {
    expect(
      pluginToolPresentation({
        toolName: 'acme',
        presentation: { card: 'generic', title: '  ' },
      })
    ).toBeUndefined();
    const kinds: Array<[ToolCallPresentation['kind'], ToolIconKind]> = [
      ['read', 'read'],
      ['edit', 'edit'],
      ['delete', 'edit'],
      ['move', 'edit'],
      ['search', 'search'],
      ['execute', 'terminal'],
      ['fetch', 'web'],
      ['other', 'tool'],
      [undefined, 'tool'],
    ];
    for (const [kind, icon] of kinds) {
      expect(
        presentedIconKind({ card: 'generic', title: 't', ...(kind ? { kind } : {}) }, 'acme'),
        String(kind)
      ).toBe(icon);
    }
  });
});

describe('the store keeps the title on the call’s block', () => {
  const SESSION = 's1';
  const MESSAGE = 'dsh-aiclient-s1-t1-s1';

  beforeEach(() => {
    resetResumeCandidatesForTests();
  });

  function state(blocks: ChatBlock[] = []): ChatSessionsState {
    const message: ChatMessage = {
      id: MESSAGE,
      role: 'assistant',
      blocks,
    } as ChatMessage;
    return {
      sessions: [],
      messages: { [SESSION]: [message] },
      hostBoundSessionIds: [],
    } as unknown as ChatSessionsState;
  }

  const event = (type: string, payload: Record<string, unknown>): RuntimeEvent =>
    ({ type, seq: 1, sessionId: SESSION, timestamp: 1, payload }) as unknown as RuntimeEvent;

  const blockOf = (patch: Partial<ChatSessionsState>) =>
    patch.messages?.[SESSION]?.[0]?.blocks.find((block) => block.type === 'tool_call');

  it('[D131-STORE-1] from `tool.started`, and from a later `tool.updated` with the complete arguments', () => {
    const started = applyRuntimeEvent(
      state(),
      event('tool.started', {
        messageId: MESSAGE,
        toolCallId: 'c1',
        name: 'word_create',
        input: OFFICE_INPUT,
        presentation: CREATE,
      })
    );
    expect(blockOf(started)?.toolPresentation).toEqual(CREATE);

    const opened = applyRuntimeEvent(
      state(),
      event('tool.started', {
        messageId: MESSAGE,
        toolCallId: 'c2',
        name: 'word_create',
        input: { __streaming: { bytes: 9, lines: 0 } },
      })
    );
    const openedBlock = blockOf(opened) as ChatBlock;
    expect(openedBlock.toolPresentation).toBeUndefined();
    const updated = applyRuntimeEvent(
      state([openedBlock]),
      event('tool.updated', {
        messageId: MESSAGE,
        toolCallId: 'c2',
        input: OFFICE_INPUT,
        presentation: CREATE,
      })
    );
    expect(blockOf(updated)).toMatchObject({ toolInput: OFFICE_INPUT, toolPresentation: CREATE });
    // The same title again changes nothing.
    const again = applyRuntimeEvent(
      state([blockOf(updated) as ChatBlock]),
      event('tool.updated', {
        messageId: MESSAGE,
        toolCallId: 'c2',
        input: OFFICE_INPUT,
        presentation: { ...CREATE },
      })
    );
    expect(again).toEqual({});
  });

  it('[D131-STORE-2] replayed: the history block’s title reaches the row as the live one did', () => {
    const patch = applyRuntimeEvent(
      { ...state(), messages: {} } as ChatSessionsState,
      {
        type: 'session.history',
        seq: 1,
        sessionId: SESSION,
        requestId: 'req-1',
        timestamp: 1,
        payload: {
          runtimeIdentity: 'rt-1',
          workspacePath: '/w',
          truncated: false,
          omittedCount: 0,
          messages: [
            {
              id: 'h:a1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_call',
                  id: 'h:a1:tool-call:c1',
                  toolCallId: 'c1',
                  name: 'word_create',
                  input: OFFICE_INPUT,
                  presentation: CREATE,
                },
                { type: 'tool_result', id: 'h:a1:tool-result:c1', toolCallId: 'c1', ok: true },
              ],
            },
          ],
        },
      } as RuntimeEvent
    );
    const blocks = patch.messages?.[SESSION]?.[0]?.blocks ?? [];
    const [row] = pairToolBlocks(blocks);
    expect(row?.presentation).toEqual(CREATE);
    expect(deriveToolRowView(row as ToolRun).title).toBe('Create docs/report.docx');
  });
});

describe('the row paints the title (DOM)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useToolExpansionStore.setState({ bySession: {} });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('[D131-DOM] the plugin’s words, untranslated, where 「编辑」 + the path would be; the fallback row unchanged', async () => {
    const blocks: ChatBlock[] = [
      {
        id: 'c1',
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'word_create',
        toolInput: OFFICE_INPUT,
        toolPresentation: CREATE,
      },
      { id: 'c1-result', type: 'tool_result', toolCallId: 'c1', toolOk: true, toolOutput: 'ok' },
      { id: 'c2', type: 'tool_call', toolCallId: 'c2', toolName: 'acme_widget', toolInput: {} },
      { id: 'c2-result', type: 'tool_result', toolCallId: 'c2', toolOk: true, toolOutput: 'ok' },
    ];
    const rows = deriveToolGroupRows(
      pairToolBlocks(blocks).map((entry) => ({ kind: 'run' as const, run: entry })),
      { t: zh }
    );
    await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: 's' })));
    const [titled, fallback] = [...container.querySelectorAll<HTMLElement>('.group\\/row')];
    const title = titled?.querySelector('[data-slot="tool-row-title"]');
    expect(title?.textContent).toBe('Create docs/report.docx');
    expect(titled?.textContent).not.toContain('编辑');
    expect(titled?.textContent).not.toContain('report.docx · ');
    expect(fallback?.querySelector('[data-slot="tool-row-title"]')).toBeNull();
    expect(fallback?.textContent).toContain('工具');
    expect(fallback?.textContent).toContain('acme_widget');
  });
});
