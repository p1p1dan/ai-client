// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e e3 (decision 142), the tool row's argument and icon:
 *
 *  - problem 18: a search pattern is shown as written — `glob **\/*` used to be
 *    split like a path into 「*（workspace） **\/」;
 *  - problem 12: a `read` of a file the user attached names the file
 *    (「附件 · notes.txt」), not DSH's content-hash folder;
 *  - problem 19: the row icon is drawn in its row's colour at full strength
 *    (it sat at 80 % on the dim tier, under 3:1), and the session failure
 *    card's title takes the body ink (dark `--destructive` cannot reach 4.5:1).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { sessionFailureTitleClass, toolRowIconClass } from '../chatTimelineLayout';
import { ToolGroup } from '../ToolRows';
import {
  attachmentFileName,
  deriveToolGroupRows,
  deriveToolRowView,
  pairToolBlocks,
} from '../toolCard';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'd0dcf05b445978e538b07399f3c729daf67fe393be5d79698f0c1d4d96f104fd';
const ATTACHED = `/tmp/h/.pilab/app/dsh-home/attachments/v1/files/d0/${SHA}/notes.txt`;

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

function done(id: string, toolName: string, toolInput: unknown, output: string): ChatBlock[] {
  return [
    { id, type: 'tool_call', toolCallId: id, toolName, toolInput },
    { id: `${id}-r`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: output },
  ];
}

function view(blocks: ChatBlock[]) {
  const [run] = pairToolBlocks(blocks);
  if (!run) throw new Error('no run');
  return deriveToolRowView(run, { t: zh, repoName: 'workspace' });
}

async function paint(blocks: ChatBlock[]) {
  const rows = deriveToolGroupRows(
    pairToolBlocks(blocks).map((run) => ({ kind: 'run' as const, run })),
    { t: zh, repoName: 'workspace' }
  );
  await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: 's' })));
  return container;
}

describe('a search pattern is shown as written (P1-7e problem 18)', () => {
  it('[E3-18-VIEW] glob, grep and find patterns are marked; a path argument is not', () => {
    const glob = view(done('g1', 'glob', { pattern: '**/*' }, 'a.txt\nsrc/b.ts'));
    expect(glob).toMatchObject({ arg: '**/*（workspace）', argPattern: true });
    expect(view(done('g2', 'grep', { pattern: 'foo/bar' }, 'x.ts:1:foo/bar'))).toMatchObject({
      argPattern: true,
    });
    expect(view(done('g3', 'find', { pattern: 'src/**/*.ts' }, 'src/a.ts')).argPattern).toBe(true);
    expect(view(done('r1', 'read', { file_path: '/repo/src/a.ts' }, 'x'))).not.toHaveProperty(
      'argPattern'
    );
  });

  it('[E3-18-PAINT] the glob row reads 「**/*（workspace）」, not a file name ahead of a folder', async () => {
    const rendered = await paint(done('g1', 'glob', { pattern: '**/*' }, 'a.txt\nsrc/b.ts'));
    const text = rendered.textContent ?? '';
    expect(text).toContain('**/*（workspace）');
    expect(text).not.toContain('*（workspace） **/');
  });

  it('[E3-18-PATH] a path argument still leads with its file name', async () => {
    const rendered = await paint(done('r1', 'read', { file_path: '/repo/src/ToolRows.tsx' }, 'x'));
    expect(rendered.textContent).toContain('ToolRows.tsx src/');
  });
});

describe('a read of an attached file names the file (P1-7e problem 12)', () => {
  it('[E3-12-NAME] DSH’s attachment copies, in either separator; nothing else', () => {
    expect(attachmentFileName(ATTACHED)).toBe('notes.txt');
    expect(
      attachmentFileName(`C:\\Users\\u\\dsh-home\\attachments\\v1\\files\\d0\\${SHA}\\报告.docx`)
    ).toBe('报告.docx');
    expect(attachmentFileName(`/repo/attachments/v1/files/d0/${SHA.slice(1)}/notes.txt`)).toBe(
      undefined
    );
    expect(attachmentFileName('/repo/src/notes.txt')).toBeUndefined();
  });

  it('[E3-12-VIEW] 「附件 · notes.txt」, with the line range when there is one; read_image too', () => {
    expect(view(done('a1', 'read', { file_path: ATTACHED }, 'FILE-MARKER'))).toMatchObject({
      arg: '附件 · notes.txt',
      argKind: 'prose',
    });
    expect(
      view(done('a2', 'read', { file_path: ATTACHED, offset: 1, limit: 20 }, 'FILE-MARKER')).arg
    ).toBe('附件 · notes.txt L1-20');
    const image = ATTACHED.replace('notes.txt', 'shot.png');
    expect(view(done('a3', 'read_image', { file_path: image }, 'ok')).arg).toBe('附件 · shot.png');
    expect(view(done('a4', 'read', { file_path: '/repo/notes.txt' }, 'x'))).toMatchObject({
      arg: 'repo/notes.txt',
      argKind: 'ident',
    });
  });

  it('[E3-12-PAINT] the row shows the name, and no hash folder', async () => {
    const rendered = await paint(done('a1', 'read', { file_path: ATTACHED }, 'FILE-MARKER'));
    expect(rendered.textContent).toContain('附件 · notes.txt');
    expect(rendered.textContent).not.toContain(SHA.slice(0, 8));
  });
});

describe('icon and failure-title contrast (P1-7e problem 19)', () => {
  it('[E3-19-ICON] the row icon is not dimmed below its row', async () => {
    expect(toolRowIconClass()).not.toMatch(/opacity-/);
    const rendered = await paint(done('g1', 'glob', { pattern: '*.txt' }, 'a.txt'));
    const icon = rendered.querySelector('svg');
    expect(icon?.getAttribute('class') ?? '').not.toMatch(/opacity-/);
  });

  it('[E3-19-TITLE] the failure card title is body ink, and the timeline uses it', () => {
    expect(sessionFailureTitleClass()).toContain('text-foreground');
    expect(sessionFailureTitleClass()).not.toContain('text-destructive');
    const timeline = readFileSync(path.join(here, '..', 'MessageTimeline.tsx'), 'utf8');
    expect(timeline).toContain('<p className={sessionFailureTitleClass()}>{t(failure.title)}</p>');
  });
});
