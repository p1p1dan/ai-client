/**
 * Layout 5c (ruling L3): the per-turn change card's aggregation — per turn →
 * distinct files, +/− totals, the first path and the review entry it opens.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SessionFileChange } from '@shared/sessionFileChange';
import { describe, expect, it } from 'vitest';
import { deriveSessionReview } from '@/components/workspace-shell/sessionReview';
import { nextChangeFocus } from '@/components/workspace-shell/workPanelModel';
import type { ChatMessage } from '@/stores/chatSessions';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { turnChangeCardClass } from '../chatTimelineLayout';
import { deriveTurnChanges, TURN_CHANGE_NAMED_FILES, turnChangeNamedFiles } from '../turnChanges';
import { stripComments } from './stripComments';

function call(
  callId: string,
  toolName: string,
  input: unknown,
  result?: { ok: boolean; output: unknown }
): ChatMessage['blocks'] {
  const blocks: ChatMessage['blocks'] = [
    { id: `${callId}-call`, type: 'tool_call', toolCallId: callId, toolName, toolInput: input },
  ];
  if (result) {
    blocks.push({
      id: `${callId}-result`,
      type: 'tool_result',
      toolCallId: callId,
      toolOk: result.ok,
      toolOutput: result.output,
    });
  }
  return blocks;
}

function reviewed(callId: string, toolName: string, review: SessionFileChange) {
  return call(
    callId,
    toolName,
    { path: review.path, content: 'x\n' },
    {
      ok: true,
      output: { content: [{ type: 'text', text: 'done' }], details: { review } },
    }
  );
}

function assistant(id: string, blocks: ChatMessage['blocks']): ChatMessage {
  return { id, sessionId: 's', role: 'assistant', blocks };
}

describe('deriveTurnChanges (layout 5c)', () => {
  it('returns null for a turn that changed no file', () => {
    expect(deriveTurnChanges([])).toBeNull();
    expect(
      deriveTurnChanges([
        assistant('m1', [
          { id: 't', type: 'text', text: 'hello' },
          ...call('r1', 'read', { path: 'a.ts' }, { ok: true, output: 'body' }),
          ...call('b1', 'bash', { command: 'ls' }, { ok: true, output: 'a.ts' }),
        ]),
      ])
    ).toBeNull();
  });

  it('counts each file once, in first-touched order, with summed +/−', () => {
    const summary = deriveTurnChanges([
      assistant('m1', [
        ...reviewed('c1', 'edit', {
          version: 1,
          path: 'src/a.ts',
          status: 'modified',
          patch: '@@ -1,2 +1,2 @@\n-old\n+new\n same',
        }),
        ...reviewed('c2', 'write', {
          version: 1,
          path: 'src/b.ts',
          status: 'added',
          patch: '@@ -0,0 +1,3 @@\n+1\n+2\n+3',
        }),
      ]),
      assistant('m2', [
        ...reviewed('c3', 'edit', {
          version: 1,
          path: 'src/a.ts',
          status: 'modified',
          patch: '@@ -5,1 +5,2 @@\n-x\n+y\n+z',
        }),
      ]),
    ]);
    expect(summary).not.toBeNull();
    expect(summary?.files).toEqual([
      { path: 'src/a.ts', added: 3, removed: 2, firstEntryId: 'm1:c1' },
      { path: 'src/b.ts', added: 3, removed: 0, firstEntryId: 'm1:c2' },
    ]);
    expect(summary?.added).toBe(6);
    expect(summary?.removed).toBe(2);
  });

  it('skips failed and unfinished calls', () => {
    const failed = call(
      'f1',
      'edit',
      { path: 'a.ts', oldText: 'a', newText: 'b' },
      { ok: false, output: 'no match' }
    );
    const pending = call('p1', 'write', { path: 'b.ts', content: 'x' });
    expect(deriveTurnChanges([assistant('m', [...failed, ...pending])])).toBeNull();
  });

  it('falls back to the argument diff when no review was recorded', () => {
    const summary = deriveTurnChanges([
      assistant(
        'm',
        call(
          'e1',
          'edit',
          { path: 'a.ts', oldText: 'one\ntwo', newText: 'one\nthree' },
          { ok: true, output: 'ok' }
        )
      ),
    ]);
    expect(summary?.files).toEqual([{ path: 'a.ts', added: 1, removed: 1, firstEntryId: 'm:e1' }]);
  });

  it('agrees with the session review the changes tab shows (same ids, same totals)', () => {
    const body = [
      assistant('m1', [
        ...reviewed('c1', 'edit', {
          version: 1,
          path: 'a.ts',
          status: 'modified',
          patch: '@@ -1 +1 @@\n-a\n+b',
        }),
        ...call(
          'e2',
          'edit',
          { path: 'b.ts', oldText: 'x', newText: 'y\nz' },
          { ok: true, output: 'ok' }
        ),
      ]),
    ];
    const summary = deriveTurnChanges(body);
    const review = deriveSessionReview(body);
    expect(summary?.files.map((file) => file.firstEntryId)).toEqual(
      review.map((entry) => entry.id)
    );
    expect(summary?.added).toBe(review.reduce((sum, entry) => sum + entry.added, 0));
    expect(summary?.removed).toBe(review.reduce((sum, entry) => sum + entry.removed, 0));
  });

  it('names the first files and counts the rest', () => {
    const files = ['a', 'b', 'c', 'd'].map((name, index) => ({
      path: `src/${name}.ts`,
      added: 1,
      removed: 0,
      firstEntryId: `m:${index}`,
    }));
    expect(TURN_CHANGE_NAMED_FILES).toBe(2);
    expect(turnChangeNamedFiles({ files, added: 4, removed: 0 })).toEqual({
      paths: ['src/a.ts', 'src/b.ts'],
      more: 2,
    });
    expect(turnChangeNamedFiles({ files: files.slice(0, 1), added: 1, removed: 0 })).toEqual({
      paths: ['src/a.ts'],
      more: 0,
    });
  });
});

describe('turnChangeCardClass (layout 5c)', () => {
  it('is the quiet stage-3 card frame: hairline, rounded-md, surface-2, no elevation', () => {
    const cls = turnChangeCardClass();
    expect(cls).toContain('border-border-soft');
    expect(cls).toContain('rounded-md');
    expect(cls).toContain('bg-surface-2');
    expect(cls).not.toMatch(/(?:^|\s)(?:elev-|shadow)/);
    expect(cls).toContain('focus-ring');
  });
});

describe('revealChange (layout 5c)', () => {
  it('nextChangeFocus names the entry and bumps seq on every request', () => {
    const first = nextChangeFocus(null, { entryId: 'm:c1', path: 'a.ts' });
    expect(first).toEqual({ entryId: 'm:c1', path: 'a.ts', seq: 1 });
    // The same card clicked again still re-reveals.
    expect(nextChangeFocus(first, { entryId: 'm:c1', path: 'a.ts' }).seq).toBe(2);
  });

  it('opens the changes pane, focuses it and records the focus (layout 5d)', () => {
    const store = useShellLayoutStore;
    store.setState({ panes: [], paneFocus: [], changeFocus: null });
    store.getState().revealChange({ entryId: 'm:c1', path: 'src/a.ts' });
    const state = store.getState();
    expect(state.panes).toContain('changes');
    expect(state.paneFocus.at(-1)).toBe('changes');
    expect(state.changeFocus).toEqual({ entryId: 'm:c1', path: 'src/a.ts', seq: 1 });
  });
});

describe('change card wiring (layout 5c)', () => {
  const file = fileURLToPath(new URL('../MessageTimeline.tsx', import.meta.url));
  const timeline = stripComments(readFileSync(file, 'utf8'), file);

  it('renders one card per turn, only once the turn settled and the changes tab can exist', () => {
    expect(timeline).toContain('deriveTurnChanges(turn.body)');
    expect(timeline).toMatch(
      /processSettled && showSessionReview && turnChanges && \(\s*<TurnChangeCard summary=\{turnChanges\} \/>/
    );
    expect(timeline.split('<TurnChangeCard').length - 1).toBe(1);
  });

  it('the card reaches the work panel through the store hook, not the shell directory', () => {
    const cardFile = fileURLToPath(new URL('../TurnChangeCard.tsx', import.meta.url));
    const card = stripComments(readFileSync(cardFile, 'utf8'), cardFile);
    expect(card).toContain("from '@/stores/shellLayout'");
    expect(card).toContain('revealChange({ entryId: first.firstEntryId, path: first.path })');
  });
});
