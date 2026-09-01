import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HISTORY_MESSAGE_ID_PREFIX } from '../../shared/types/sessionHistory.ts';
import {
  CODEX_HISTORY_MAX_MESSAGES,
  CODEX_HISTORY_OUTPUT_BUDGET_CHARS,
  CODEX_HISTORY_PAGINATION_KEYS,
  reprojectCodexHistory,
} from '../codexHistoryReader.ts';
import { CODEX_TOOL_OUTPUT_MAX_CHARS } from '../codexItemMapper.ts';

/**
 * S3 slice 5b — `thread/resume` result -> `HistoryMessage[]` (G4/G5/G9a/G15).
 *
 * Two evidence classes, kept visibly apart:
 *
 *  - REAL: `fixtures/codex/codex-s5-thread-resume.jsonl` line 9, the only
 *    recorded resume result we own (codex-cli 0.145.0, real quota spent). G4
 *    and G9a assert against it verbatim — including the epoch-second stamps,
 *    which are the class of bug (×1000 or not) that no shape assertion catches.
 *  - SYNTHETIC: hand-built inputs for a PURE function, used for the cases the
 *    single capture cannot contain (two turns, missing ids, a non-null cursor,
 *    an over-cap history). These are inputs, never claims about the wire: the
 *    fixtures README forbids inventing frames, and nothing here is written to
 *    the fixtures directory or presented as a capture.
 *
 * L5 stands: multi-turn and approval/question threads have never been captured,
 * so the multi-turn behaviour below is verified against the CONTRACT (ids,
 * stamps, caps), not against a claim about what codex would really send.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'codex');
const RESUME_FIXTURE = 'codex-s5-thread-resume.jsonl';
/** 1-based, as documented in the fixtures README's S5 section. */
const RESUME_RESULT_LINE = 9;

const THREAD_ID = '01a003a5-307f-77d1-b7a4-a5379a560067';
const TURN_ID = '01a003a5-30be-7c00-babd-923890f7a5ba';
const PROBE_TEXT =
  'First use your shell tool to run exactly: echo u2a-probe . Then reply with exactly DONE and nothing else.';

interface FixtureEnvelope {
  dir: string;
  tMs: number | null;
  raw: { id?: number; method?: string; result?: unknown };
}

function loadResumeResult(): unknown {
  const lines = readFileSync(path.join(FIXTURES, RESUME_FIXTURE), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const frame = JSON.parse(lines[RESUME_RESULT_LINE - 1]) as FixtureEnvelope;
  return frame.raw.result;
}

interface IdCollection {
  messageIds: string[];
  blockIds: string[];
  toolCallIds: string[];
}

function collectIds(messages: readonly { id: string; blocks: readonly unknown[] }[]): IdCollection {
  const collected: IdCollection = { messageIds: [], blockIds: [], toolCallIds: [] };
  for (const message of messages) {
    collected.messageIds.push(message.id);
    for (const raw of message.blocks) {
      const block = raw as { id: string; toolCallId?: string };
      collected.blockIds.push(block.id);
      if (typeof block.toolCallId === 'string') collected.toolCallIds.push(block.toolCallId);
    }
  }
  return collected;
}

describe('G4 — the one recorded resume result', () => {
  it('is still the frame this file thinks it is', () => {
    // Pins the fixture line: a reshuffled capture must fail here, loudly,
    // rather than turn every assertion below into a test of `{}`.
    const result = loadResumeResult() as { thread: { id: string; turns: unknown[] } };
    expect(result.thread.id).toBe(THREAD_ID);
    expect(result.thread.turns).toHaveLength(1);
  });

  it('reprojects to exactly the two messages 0.145.0 stores', () => {
    const out = reprojectCodexHistory(loadResumeResult());

    expect(out.messages).toHaveLength(2);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Full id equality, not `toContain`: the namespace is the whole point of
    // this module, and threadId+turnId+itemId must all be in it (F1).
    expect(out.messages[0].id).toBe(
      `${HISTORY_MESSAGE_ID_PREFIX}codex:${THREAD_ID}:${TURN_ID}:item-1`
    );
    expect(out.messages[1].id).toBe(
      `${HISTORY_MESSAGE_ID_PREFIX}codex:${THREAD_ID}:${TURN_ID}:item-2`
    );
    for (const message of out.messages) {
      expect(message.id).toContain(THREAD_ID);
      expect(message.id).toContain(TURN_ID);
    }
  });

  it('converts the epoch SECONDS on the turn into epoch millis', () => {
    const out = reprojectCodexHistory(loadResumeResult());
    // startedAt 1786767552 / completedAt 1786767565 [实测] — the user message
    // is stamped when the turn opened, the closing agent message when it ended.
    expect(out.messages[0].timestamp).toBe(1786767552000);
    expect(out.messages[1].timestamp).toBe(1786767565000);
  });

  it('reports an untruncated read: all three pagination cursors are null', () => {
    const result = loadResumeResult() as Record<string, unknown>;
    for (const key of CODEX_HISTORY_PAGINATION_KEYS) {
      expect(result[key]).toBeNull();
    }
    const out = reprojectCodexHistory(result);
    expect(out.truncated).toBe(false);
    expect(out.omittedCount).toBe(0);
    expect(out.stats).toMatchObject({ turns: 1, items: 2, rendered: 2, skipped: 0 });
  });

  it('prefers the session handle over the echoed thread id, and falls back to the echo', () => {
    const withHandle = reprojectCodexHistory(loadResumeResult(), { threadId: 'session-handle' });
    expect(withHandle.messages[0].id).toBe(
      `${HISTORY_MESSAGE_ID_PREFIX}codex:session-handle:${TURN_ID}:item-1`
    );
    // No handle passed: the echo carries the namespace (asserted above), and a
    // result with neither still produces usable, undefined-free ids.
    const headless = reprojectCodexHistory({
      thread: { turns: [{ items: [{ type: 'agentMessage', text: 'hi' }] }] },
    });
    expect(headless.messages[0].id).toBe(`${HISTORY_MESSAGE_ID_PREFIX}codex:thread:turn-1:item-p1`);
  });
});

describe('G9a — the two reprojected item shapes 0.145.0 produces', () => {
  it('renders the userMessage content[] form and the agentMessage text form', () => {
    const out = reprojectCodexHistory(loadResumeResult());

    // content[]-shaped user message.
    expect(out.messages[0].blocks).toEqual([
      { type: 'text', id: `codex:${THREAD_ID}:${TURN_ID}:item-1:text`, text: PROBE_TEXT },
    ]);
    // text-shaped agent message.
    expect(out.messages[1].blocks).toEqual([
      { type: 'text', id: `codex:${THREAD_ID}:${TURN_ID}:item-2:text`, text: 'DONE' },
    ]);
  });

  it('pins L1: the reprojection carries no reasoning and no tool rows', () => {
    // The live turn had four items (userMessage / reasoning / commandExecution /
    // agentMessage [实测 codex-s5-u2a-report.json liveItems]); resume returns
    // two. This is a storage property of 0.145.0, not a reader gap — G9b's
    // manual upgrade gate re-checks the item-type set, because a fixed fixture
    // can never go red on its own.
    const out = reprojectCodexHistory(loadResumeResult());
    const types = out.messages.flatMap((m) => m.blocks.map((b) => b.type));
    expect(types).toEqual(['text', 'text']);
  });
});

/**
 * SYNTHETIC input — a hand-built argument to a pure function, NOT a capture.
 *
 * Turn 1 has a real turn id and per-item ids plus one item the mapper declares
 * unrendered; turn 2 has NEITHER a turn id NOR item ids, and repeats the same
 * item types, which is the collision case: the mapper derives its block ids
 * from the item type when the id is missing, so two id-less agentMessages in
 * one turn would share a block id under prefix-only namespacing.
 */
function syntheticTwoTurns(): unknown {
  return {
    thread: {
      id: 'thread-syn',
      turns: [
        {
          id: 'turn-uuid-a',
          startedAt: 100,
          completedAt: 200,
          status: 'completed',
          items: [
            { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'hello' }] },
            {
              type: 'commandExecution',
              id: 'item-2',
              command: 'echo hi',
              status: 'completed',
              aggregatedOutput: 'hi',
            },
            { type: 'plan', id: 'item-3', steps: [] },
            { type: 'agentMessage', id: 'item-4', text: 'done' },
          ],
        },
        {
          startedAt: 300,
          completedAt: null,
          status: 'completed',
          items: [
            { type: 'userMessage', content: 'again' },
            { type: 'sleep', durationMs: 5 },
            { type: 'agentMessage', text: 'first' },
            { type: 'commandExecution', command: 'echo two', status: 'completed' },
            { type: 'agentMessage', text: 'second' },
          ],
        },
      ],
    },
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

describe('G5 — id namespacing across turns', () => {
  it('drops unrendered items and keeps one message per rendered item', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns());
    // 4 + 5 items in, `plan` and `sleep` declared unrendered by the mapper.
    expect(out.messages).toHaveLength(7);
    expect(out.stats).toMatchObject({ turns: 2, items: 9, rendered: 7, skipped: 2, unknown: 0 });
  });

  it('makes message ids, block ids and toolCallIds globally unique', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns());
    const { messageIds, blockIds, toolCallIds } = collectIds(out.messages);

    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(new Set(blockIds).size).toBe(blockIds.length);
    // Two tool items, each contributing a call and a result that SHARE one id:
    // 4 occurrences, 2 distinct values. Both halves matter — unique per item,
    // identical within an item, or the renderer cannot pair a result.
    expect(toolCallIds).toHaveLength(4);
    expect(new Set(toolCallIds).size).toBe(2);
  });

  it('never interpolates an undefined into an id', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns());
    const { messageIds, blockIds, toolCallIds } = collectIds(out.messages);
    for (const id of [...messageIds, ...blockIds, ...toolCallIds]) {
      expect(id).not.toContain('undefined');
      expect(id.startsWith(HISTORY_MESSAGE_ID_PREFIX) || id.startsWith('codex:')).toBe(true);
    }
  });

  it('falls back to positional turn/item ids that keep the raw item index', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns(), { threadId: 'thread-syn' });
    const turnTwo = out.messages.slice(3).map((m) => m.id);
    // `sleep` sat at index 1 and was skipped: the items after it keep p3/p4/p5
    // rather than being renumbered, so a future codex that renders `sleep` does
    // not silently rewrite the ids of everything behind it.
    expect(turnTwo).toEqual([
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-syn:turn-2:item-p1`,
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-syn:turn-2:item-p3`,
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-syn:turn-2:item-p4`,
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-syn:turn-2:item-p5`,
    ]);
  });

  it('re-keys the id-less blocks per item instead of per item type', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns());
    // Both are id-less agentMessages in the same turn — the mapper gives both
    // the base `codex-agentMessage`, so only base substitution (not prefixing)
    // keeps these two apart.
    expect(out.messages[4].blocks[0].id).toBe('codex:thread-syn:turn-2:item-p3:text');
    expect(out.messages[6].blocks[0].id).toBe('codex:thread-syn:turn-2:item-p5:text');

    const tool = out.messages[5];
    expect(tool.blocks.map((b) => b.id)).toEqual([
      'codex:thread-syn:turn-2:item-p4:call',
      'codex:thread-syn:turn-2:item-p4:result',
    ]);
    // Call and result keep ONE shared toolCallId after the rewrite.
    expect(collectIds([tool]).toolCallIds).toEqual([
      'codex:thread-syn:turn-2:item-p4',
      'codex:thread-syn:turn-2:item-p4',
    ]);
  });

  it('stamps the closing agent message with completedAt and everything else with startedAt', () => {
    const out = reprojectCodexHistory(syntheticTwoTurns());
    // Turn 1: startedAt 100s for the user message and the tool row, completedAt
    // 200s for the last agentMessage.
    expect(out.messages.slice(0, 3).map((m) => m.timestamp)).toEqual([100_000, 100_000, 200_000]);
    // Turn 2 has completedAt null -> the closing agent message falls back to
    // startedAt rather than being left unstamped or stamped "now".
    expect(out.messages.slice(3).map((m) => m.timestamp)).toEqual([
      300_000, 300_000, 300_000, 300_000,
    ]);
  });
});

describe('G15 — pagination honesty and the message cap', () => {
  it('reports truncated for a non-null value on any single cursor key', () => {
    for (const key of CODEX_HISTORY_PAGINATION_KEYS) {
      const input = syntheticTwoTurns() as Record<string, unknown>;
      input[key] = '{"turnId":"synthetic-cursor"}';
      const out = reprojectCodexHistory(input);
      expect(out.truncated).toBe(true);
      // Truncation by pagination is not eviction: nothing was dropped by us.
      expect(out.omittedCount).toBe(0);
      expect(out.messages).toHaveLength(7);
    }
  });

  it('does not report truncated when the keys are null or absent', () => {
    expect(reprojectCodexHistory(syntheticTwoTurns()).truncated).toBe(false);
    expect(reprojectCodexHistory({ thread: { id: 't', turns: [] } }).truncated).toBe(false);
  });

  it('evicts from the head at the shared message cap and counts what it dropped', () => {
    const overflow = 5;
    const total = CODEX_HISTORY_MAX_MESSAGES + overflow;
    const items = Array.from({ length: total }, (_, i) => ({
      type: 'userMessage',
      id: `item-${i + 1}`,
      content: [{ type: 'text', text: `m${i + 1}` }],
    }));
    const out = reprojectCodexHistory({
      thread: { id: 'thread-cap', turns: [{ id: 'turn-cap', startedAt: 1, items }] },
    });

    expect(out.messages).toHaveLength(CODEX_HISTORY_MAX_MESSAGES);
    expect(out.omittedCount).toBe(overflow);
    expect(out.truncated).toBe(true);
    // Head eviction, not tail: the OLDEST messages go, the newest survive.
    expect(out.messages[0].id).toBe(
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-cap:turn-cap:item-${overflow + 1}`
    );
    expect(out.messages[CODEX_HISTORY_MAX_MESSAGES - 1].id).toBe(
      `${HISTORY_MESSAGE_ID_PREFIX}codex:thread-cap:turn-cap:item-${total}`
    );
  });

  it('also evicts on the shared serialized-size budget, below the message cap', () => {
    const text = 'x'.repeat(CODEX_TOOL_OUTPUT_MAX_CHARS);
    const total = Math.ceil(CODEX_HISTORY_OUTPUT_BUDGET_CHARS / CODEX_TOOL_OUTPUT_MAX_CHARS) + 20;
    // Well under the message cap, so only the byte budget can evict here.
    expect(total).toBeLessThan(CODEX_HISTORY_MAX_MESSAGES);
    const items = Array.from({ length: total }, (_, i) => ({
      type: 'agentMessage',
      id: `item-${i + 1}`,
      text,
    }));
    const out = reprojectCodexHistory({
      thread: { id: 'thread-big', turns: [{ id: 'turn-big', startedAt: 1, items }] },
    });

    expect(out.omittedCount).toBeGreaterThan(0);
    expect(out.messages.length).toBe(total - out.omittedCount);
    expect(out.truncated).toBe(true);
  });

  it('never throws on a shape it does not recognise', () => {
    const junk = [null, undefined, 42, 'nope', [], { thread: 7 }, { thread: { turns: 3 } }];
    for (const input of junk) {
      const out = reprojectCodexHistory(input);
      expect(out.messages).toEqual([]);
      expect(out.truncated).toBe(false);
      expect(out.omittedCount).toBe(0);
    }
  });
});
