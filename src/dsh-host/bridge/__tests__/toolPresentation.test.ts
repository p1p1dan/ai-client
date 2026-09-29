import { describe, expect, it, vi } from 'vitest';
import {
  DSH_BUILTIN_TOOL_NAMES,
  isDshBuiltinTool,
  narrowToolCallPresentation,
  sameToolCallPresentation,
  TOOL_PRESENTATION_TEXT_MAX,
} from '../../../shared/dshToolPresentation.ts';
import { DSH_TOOL_CLASSES, PLUGIN_TOOL_CLASSES } from '../../permissions/classification.ts';
import { type DshToolRegistryView, dshToolPresenter } from '../toolPresentation.ts';

/**
 * dsh-rebase decision 131 (decision 073 rule 1, decision 120 item 27): a
 * plugin tool's own title for a call, asked of DSH's tool registry — who is
 * asked, what is kept of the answer, and that nothing the plugin does can cost
 * the row. The real registry and the pilot plugin run under bridge-smoke
 * (host I); here the registry is a fake shaped like `ctx.tools.get`.
 */

/** `dsh-office-tools@1.0.4`'s own `presentCall` (lib/index.js: `word_create`, `word_read`). */
const officeCreate = (args: { path: string }) => ({
  card: 'generic',
  title: `Create ${args.path}`,
  kind: 'edit',
  locations: [{ path: args.path }],
});
const officeRead = (args: { path: string }) => ({
  card: 'generic',
  title: `Read ${args.path}`,
  kind: 'read',
  locations: [{ path: args.path }],
});

function registry(tools: Record<string, { presentCall?: (args: never) => unknown }>) {
  const get = vi.fn((name: string, _scope?: object) => tools[name]);
  return { view: { get } as DshToolRegistryView, get };
}

describe('the DSH tools a presentation is never asked for', () => {
  it("[D131-LIST] is the permission gate's DSH table, which the bridge bundle may not import", () => {
    expect([...DSH_BUILTIN_TOOL_NAMES].sort()).toEqual(Object.keys(DSH_TOOL_CLASSES).sort());
  });

  it("[D131-LIST-PLUGIN] names none of the allowlisted plugins' tools", () => {
    const plugin = Object.keys(PLUGIN_TOOL_CLASSES);
    expect(plugin.length).toBeGreaterThan(0);
    expect(plugin.filter((name) => isDshBuiltinTool(name))).toEqual([]);
  });
});

describe('narrowToolCallPresentation', () => {
  it('[D131-NARROW-1] keeps the card, the title and the category; drops the locations and the raw input', () => {
    expect(narrowToolCallPresentation(officeCreate({ path: 'report.docx' }))).toEqual({
      card: 'generic',
      title: 'Create report.docx',
      kind: 'edit',
    });
    expect(
      narrowToolCallPresentation({
        card: 'generic',
        title: 'Fetch the page',
        kind: 'fetch',
        rawInput: { secret: 'x' },
        content: [{ type: 'text', text: 'x' }],
      })
    ).toEqual({ card: 'generic', title: 'Fetch the page', kind: 'fetch' });
  });

  it("[D131-NARROW-2] a terminal card keeps its description; a diff card drops the files' new text", () => {
    expect(
      narrowToolCallPresentation({
        card: 'terminal',
        title: 'npm test',
        description: 'Run the tests',
        cwd: '/w',
      })
    ).toEqual({ card: 'terminal', title: 'npm test', description: 'Run the tests' });
    expect(
      narrowToolCallPresentation({
        card: 'diff',
        title: 'Write notes.md',
        diffs: [{ path: 'notes.md', oldText: null, newText: 'a'.repeat(10_000) }],
        kind: 'edit',
      })
    ).toEqual({ card: 'diff', title: 'Write notes.md' });
  });

  it('[D131-NARROW-3] reverse: no card it knows, or no title, is no presentation; an unknown category is left out', () => {
    for (const view of [
      undefined,
      null,
      'Create report.docx',
      [],
      { card: 'banner', title: 'x' },
      { card: 'generic' },
      { card: 'generic', title: '   \n ' },
      { card: 'generic', title: 42 },
    ]) {
      expect(narrowToolCallPresentation(view), JSON.stringify(view)).toBeUndefined();
    }
    expect(narrowToolCallPresentation({ card: 'generic', title: 'x', kind: 'launch' })).toEqual({
      card: 'generic',
      title: 'x',
    });
  });

  it('[D131-NARROW-4] one line, cut at the cap by code point', () => {
    expect(
      narrowToolCallPresentation({ card: 'generic', title: '  Create\n  report.docx \t' })?.title
    ).toBe('Create report.docx');
    const long = narrowToolCallPresentation({ card: 'generic', title: '文'.repeat(500) })?.title;
    expect(Array.from(long ?? '')).toHaveLength(TOOL_PRESENTATION_TEXT_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('[D131-SAME] compares every field it keeps', () => {
    const a = { card: 'generic' as const, title: 'Read a.docx', kind: 'read' as const };
    expect(sameToolCallPresentation(a, { ...a })).toBe(true);
    expect(sameToolCallPresentation(a, { ...a, kind: 'edit' })).toBe(false);
    expect(sameToolCallPresentation(a, undefined)).toBe(false);
    expect(sameToolCallPresentation(undefined, undefined)).toBe(true);
  });
});

describe('dshToolPresenter', () => {
  it("[D131-ASK-1] asks a plugin tool, through the session's own agent", () => {
    const { view, get } = registry({ word_create: { presentCall: officeCreate as never } });
    const agent = { id: 'aiclient-s1' };
    const present = dshToolPresenter(
      () => view,
      () => agent
    );
    expect(present('word_create', { path: 'out/report.docx', title: 'Q3' })).toEqual({
      card: 'generic',
      title: 'Create out/report.docx',
      kind: 'edit',
    });
    expect(get).toHaveBeenCalledWith('word_create', agent);
  });

  it("[D131-ASK-2] reverse: never asks about one of DSH's own tools, even one that presents itself", () => {
    const presentCall = vi.fn(() => ({ card: 'terminal', title: 'ls' }));
    const { view, get } = registry({ bash: { presentCall }, read: { presentCall } });
    const present = dshToolPresenter(() => view);
    expect(present('bash', { command: 'ls' })).toBeUndefined();
    expect(present('read', { file_path: 'a.ts' })).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(presentCall).not.toHaveBeenCalled();
  });

  it('[D131-ASK-3] no registry, no such tool, no presentCall, or one that throws: no title, and no throw', () => {
    const throwing = vi.fn(() => {
      throw new Error('plugin bug');
    });
    const { view } = registry({
      word_read: { presentCall: officeRead as never },
      quiet: {},
      broken: { presentCall: throwing },
      odd: { presentCall: () => ({ card: 'generic', title: '' }) },
    });
    const present = dshToolPresenter(() => view);
    expect(dshToolPresenter(() => undefined)('word_read', { path: 'a.docx' })).toBeUndefined();
    expect(present('missing', {})).toBeUndefined();
    expect(present('quiet', {})).toBeUndefined();
    expect(present('broken', {})).toBeUndefined();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(present('odd', {})).toBeUndefined();
    expect(present('', {})).toBeUndefined();
    const lookupThrows = dshToolPresenter(() => ({
      get: () => {
        throw new Error('registry disposed');
      },
    }));
    expect(lookupThrows('word_read', { path: 'a.docx' })).toBeUndefined();
    // A presenter still answers after all that.
    expect(present('word_read', { path: 'a.docx' })?.title).toBe('Read a.docx');
  });

  it('[D131-ASK-4] reads the registry and the agent per call: the agent opens after the runtime', () => {
    const { view, get } = registry({ word_read: { presentCall: officeRead as never } });
    let agent: object | undefined;
    const present = dshToolPresenter(
      () => view,
      () => agent
    );
    present('word_read', { path: 'a.docx' });
    agent = { id: 'aiclient-s1' };
    present('word_read', { path: 'a.docx' });
    expect(get.mock.calls.map((call) => call[1])).toEqual([undefined, agent]);
  });
});
