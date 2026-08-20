import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_ITEM_RULES,
  CODEX_ITEM_TYPES,
  CODEX_TOOL_OUTPUT_MAX_CHARS,
  mapCodexItem,
  toPermissionFileChanges,
} from '../codexItemMapper.ts';

/**
 * The item mapper's job is to make "codex added a new item type" LOUD.
 *
 * Every other assertion here is about one variant; the first describe block is
 * the one that matters most, because a silently dropped item type is invisible
 * — the turn still completes, the transcript is just missing something, and
 * nobody finds out until a user reports a blank spot.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'codex');

interface MethodContract {
  threadItemTypes: string[];
}

const contract = JSON.parse(
  readFileSync(path.join(FIXTURES, 'codex-method-contract.json'), 'utf8')
) as MethodContract;

interface Envelope {
  dir: string;
  raw: { method?: string; params?: Record<string, unknown> };
}

function loadTurn(file: string): Envelope[] {
  return readFileSync(path.join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

/** The item body of the Nth frame of a recorded turn. */
function itemAt(file: string, index: number): unknown {
  const frame = loadTurn(file)[index];
  return frame?.raw?.params?.item;
}

const FILECHANGE_TURN = 'codex-filechange-approval-turn.jsonl';
const QUESTION_TURN = 'codex-question-turn-status.jsonl';

describe('the mapping table covers the contract exactly', () => {
  it('has one rule per declared threadItemType, and no rule for anything else', () => {
    // THE assertion of this file. A codex upgrade that adds a 19th item type
    // turns this red, instead of that type falling through a `default:` branch
    // and vanishing from the transcript.
    expect([...CODEX_ITEM_TYPES].sort()).toEqual([...contract.threadItemTypes].sort());
  });

  it('pins the count so an emptied contract cannot make the check vacuous', () => {
    expect(CODEX_ITEM_TYPES.length).toBe(18);
  });

  it('gives every variant a reason a reader can act on', () => {
    for (const [type, rule] of Object.entries(CODEX_ITEM_RULES)) {
      expect(rule.note.length, `${type} needs a note`).toBeGreaterThan(10);
      if (rule.mode === 'not_rendered') {
        expect(rule.skipReason, `${type} must say WHY it is dropped`).toBeDefined();
      } else {
        // A rendered variant carrying a skip reason would be a half-edited rule.
        expect(rule.skipReason).toBeUndefined();
      }
    }
  });
});

describe('the two subagent-shaped variants are dropped on purpose', () => {
  it('subAgentActivity is explicitly skipped, not missing', () => {
    // The distinction this test defends: `CODEX_ITEM_RULES.subAgentActivity`
    // existing with `not_rendered` is a decision (T-34's payload is Claude's
    // 9-kind union; S1 measured ~385 lines to fake it). The rule being ABSENT
    // would be an oversight, and the exhaustiveness test above cannot tell the
    // two apart on its own.
    const rule = CODEX_ITEM_RULES.subAgentActivity;
    expect(rule).toBeDefined();
    expect(rule?.mode).toBe('not_rendered');
    expect(rule?.skipReason).toBe('subagent_axis');

    const mapping = mapCodexItem({ type: 'subAgentActivity', id: 'sub-1', text: 'inner work' });
    expect(mapping.outcome).toBe('skipped');
    expect(mapping.blocks).toEqual([]);
    expect(mapping.skipReason).toBe('subagent_axis');
  });

  it('collabAgentToolCall drops for the same reason, so no collaborator work lands on the main row', () => {
    const mapping = mapCodexItem({
      type: 'collabAgentToolCall',
      id: 'collab-1',
      status: 'completed',
    });
    expect(mapping.outcome).toBe('skipped');
    expect(mapping.skipReason).toBe('subagent_axis');
    expect(mapping.blocks).toEqual([]);
  });
});

describe('recorded items project into blocks', () => {
  it('userMessage becomes one user text block', () => {
    const mapping = mapCodexItem(itemAt(FILECHANGE_TURN, 1));
    expect(mapping.outcome).toBe('rendered');
    expect(mapping.role).toBe('user');
    expect(mapping.blocks).toEqual([
      {
        type: 'text',
        id: '019fd82d-aece-75f2-86e9-d04e245aa1f1:text',
        text: expect.stringContaining('probe_b.txt'),
      },
    ]);
  });

  it('agentMessage becomes one assistant text block', () => {
    const mapping = mapCodexItem(itemAt(FILECHANGE_TURN, 16));
    expect(mapping.role).toBe('assistant');
    expect(mapping.blocks[0]).toMatchObject({ type: 'text' });
    expect((mapping.blocks[0] as { text: string }).text).toContain('probe_b.txt');
  });

  it('agentMessage with phase:final_answer exposes phase on the mapping', () => {
    const mapping = mapCodexItem({
      type: 'agentMessage',
      id: 'am-1',
      text: 'done',
      phase: 'final_answer',
    });
    expect(mapping.outcome).toBe('rendered');
    expect(mapping.phase).toBe('final_answer');
    expect(mapping.blocks[0]).toMatchObject({ type: 'text', text: 'done' });
  });

  it('agentMessage with phase:commentary exposes phase on the mapping (same render path as final_answer)', () => {
    const mapping = mapCodexItem({
      type: 'agentMessage',
      id: 'am-2',
      text: 'thinking aloud',
      phase: 'commentary',
    });
    expect(mapping.outcome).toBe('rendered');
    expect(mapping.phase).toBe('commentary');
    expect(mapping.blocks[0]).toMatchObject({ type: 'text', text: 'thinking aloud' });
  });

  it('agentMessage with an unknown phase value passes it through instead of throwing', () => {
    const mapping = mapCodexItem({
      type: 'agentMessage',
      id: 'am-3',
      text: 'hi',
      phase: 'future_phase_x',
    });
    expect(mapping.outcome).toBe('rendered');
    expect(mapping.phase).toBe('future_phase_x');
  });

  it('agentMessage with phase:null maps to phase:null on the mapping', () => {
    const mapping = mapCodexItem({ type: 'agentMessage', id: 'am-4', text: 'hi', phase: null });
    expect(mapping.phase).toBeNull();
  });

  it('non-agentMessage items always have phase:null on the mapping', () => {
    const mapping = mapCodexItem({
      type: 'reasoning',
      id: 'rs-1',
      summary: [{ type: 'summary_text', text: 'x' }],
    });
    expect(mapping.phase).toBeNull();
  });

  it('reasoning becomes a thinking block carrying the summary', () => {
    const mapping = mapCodexItem(itemAt(FILECHANGE_TURN, 4));
    expect(mapping.blocks).toEqual([
      {
        type: 'thinking',
        id: 'rs_0909e2da3b5255ca016a74c8211c388191a8de6d2bd9cc1cad:reasoning',
        text: '**Implementing apply_patch execution**',
      },
    ]);
  });

  it('commandExecution becomes a tool row whose result is the aggregated output', () => {
    const mapping = mapCodexItem(itemAt(QUESTION_TURN, 8));
    const [call, result] = mapping.blocks;
    expect(call).toMatchObject({
      type: 'tool_call',
      name: 'shell',
      toolCallId: 'exec-2a5952ad-bbef-4dc0-83ae-87c04a3b7703',
    });
    // The input is the item minus its envelope keys — a per-variant whitelist
    // would have to guess at the four variants we have no frame for.
    const input = (call as { input: Record<string, unknown> }).input;
    expect(input.command).toContain('rg --files');
    expect(input.cwd).toContain('sandbox');
    expect(input).not.toHaveProperty('type');
    expect(input).not.toHaveProperty('id');
    expect(result).toMatchObject({ type: 'tool_result', ok: true });
    expect((result as { output: string }).output).toContain('# demo-app');
  });

  it('an in-flight item yields the call block and no result', () => {
    // `item/started` and `item/completed` go through the same function, so the
    // running row must not claim an outcome it does not have yet.
    const mapping = mapCodexItem(itemAt(FILECHANGE_TURN, 7));
    expect(mapping.blocks).toHaveLength(1);
    expect(mapping.blocks[0]?.type).toBe('tool_call');
  });

  it('a declined fileChange settles as a failed tool row', () => {
    const mapping = mapCodexItem(itemAt(FILECHANGE_TURN, 12));
    const [call, result] = mapping.blocks;
    expect(call).toMatchObject({ type: 'tool_call', name: 'apply_patch' });
    expect(result).toMatchObject({ type: 'tool_result', ok: false, error: 'declined' });
  });

  it('is pure: the same item maps identically and the input is untouched', () => {
    const item = itemAt(FILECHANGE_TURN, 12) as Record<string, unknown>;
    const before = JSON.stringify(item);
    const first = mapCodexItem(item);
    const second = mapCodexItem(item);
    expect(first).toEqual(second);
    // Slice 5b replays history through this same function; a mapper that
    // mutated its input would corrupt the frame the live path also holds.
    expect(JSON.stringify(item)).toBe(before);
  });
});

describe('items outside the contract degrade instead of disappearing', () => {
  it('reports an unknown type verbatim', () => {
    const mapping = mapCodexItem({ type: 'quantumThought', id: 'q1' });
    expect(mapping.outcome).toBe('unknown');
    expect(mapping.itemType).toBe('quantumThought');
    expect(mapping.blocks).toEqual([]);
    expect(mapping.note).toContain('quantumThought');
  });

  it.each([
    [null],
    [undefined],
    ['a string'],
    [42],
    [[]],
  ])('never throws on a non-item frame (%p)', (input) => {
    const mapping = mapCodexItem(input);
    expect(mapping.outcome).toBe('malformed');
    expect(mapping.blocks).toEqual([]);
  });

  it('an item without a type is malformed, not unknown', () => {
    // Different incidents: "codex sent something new" vs "this frame is broken".
    expect(mapCodexItem({ id: 'x' }).outcome).toBe('malformed');
  });

  it('a rendered item without an id still gets collision-free block ids', () => {
    const mapping = mapCodexItem({ type: 'agentMessage', text: 'hi' });
    expect(mapping.blocks[0]?.id).toBe('codex-agentMessage:text');
  });
});

describe('tool output is clamped before it crosses IPC', () => {
  it('flags a clamped aggregatedOutput as truncated', () => {
    const mapping = mapCodexItem({
      type: 'commandExecution',
      id: 'exec-big',
      status: 'completed',
      aggregatedOutput: 'x'.repeat(CODEX_TOOL_OUTPUT_MAX_CHARS + 100),
    });
    const result = mapping.blocks[1] as { output: string; truncated?: boolean };
    expect(result.output).toHaveLength(CODEX_TOOL_OUTPUT_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('a failed command carries its exit code in the error line', () => {
    const mapping = mapCodexItem({
      type: 'commandExecution',
      id: 'exec-fail',
      status: 'failed',
      exitCode: 127,
    });
    expect(mapping.blocks[1]).toMatchObject({ ok: false, error: 'failed (exit code 127)' });
  });
});

describe('toPermissionFileChanges — the diff slice 4 will render', () => {
  it('projects the recorded item/started patch', () => {
    // This is the frame that arrives at 11235ms; the approval request that
    // needs it arrives at 11236ms carrying no patch at all.
    const detail = toPermissionFileChanges(itemAt(FILECHANGE_TURN, 7));
    expect(detail).toEqual({
      kind: 'file_change',
      changes: [{ path: expect.stringContaining('probe_b.txt'), change: 'add', diff: 'hi\n' }],
    });
  });

  it('returns null when there is no change list, rather than an empty body', () => {
    // "The diff has not arrived" and "the patch is empty" must not look alike.
    expect(toPermissionFileChanges({ type: 'fileChange', id: 'x' })).toBeNull();
    expect(toPermissionFileChanges({ type: 'fileChange', id: 'x', changes: [] })).toBeNull();
    expect(toPermissionFileChanges(null)).toBeNull();
  });

  it('counts the files it dropped instead of narrowing the card silently', () => {
    const changes = Array.from({ length: 25 }, (_, i) => ({
      path: `/tmp/f${i}.txt`,
      kind: { type: 'add' },
      diff: 'x',
    }));
    const detail = toPermissionFileChanges({ type: 'fileChange', id: 'x', changes });
    expect(detail?.kind).toBe('file_change');
    if (detail?.kind !== 'file_change') throw new Error('unreachable');
    expect(detail.changes).toHaveLength(20);
    expect(detail.omittedFileCount).toBe(5);
  });

  it('clamps a huge diff and says so', () => {
    const detail = toPermissionFileChanges({
      type: 'fileChange',
      id: 'x',
      changes: [{ path: '/tmp/big.txt', kind: { type: 'update' }, diff: 'y'.repeat(70 * 1024) }],
    });
    if (detail?.kind !== 'file_change') throw new Error('unreachable');
    expect(detail.changes[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(detail.changes[0]?.diff ?? '', 'utf8')).toBe(64 * 1024);
  });

  it('keeps an unrecognised change kind on the card as an update', () => {
    // Only `add` has a recorded frame. Dropping a file whose verb we cannot
    // read would hide it from the approval card entirely, which is worse than
    // an imprecise verb next to a diff the user can read.
    const detail = toPermissionFileChanges({
      type: 'fileChange',
      id: 'x',
      changes: [{ path: '/tmp/a', kind: { type: 'transmute' }, diff: 'z' }],
    });
    if (detail?.kind !== 'file_change') throw new Error('unreachable');
    expect(detail.changes[0]?.change).toBe('update');
  });

  it('drops a change with no path, since a card cannot render one', () => {
    const detail = toPermissionFileChanges({
      type: 'fileChange',
      id: 'x',
      changes: [
        { kind: { type: 'add' }, diff: 'z' },
        { path: '/tmp/ok', kind: { type: 'add' } },
      ],
    });
    if (detail?.kind !== 'file_change') throw new Error('unreachable');
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0]?.path).toBe('/tmp/ok');
  });
});
