/**
 * Decision 212 (user, 2026-11-09): a subagent is one step — its name, what it
 * was asked, and one `⎿` line — in Claude Code's words (2.1.273 `Lrn`, `n1e`,
 * `vsr`). Truth table for the words; `turnLiveStatusMount.test.ts` locks the DOM.
 */
import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { compactTokens, delegationName, deriveDelegationLine } from '../delegationLine';
import type { SubagentLane } from '../subagentActivityModel';
import { deriveToolGroupRows, groupTimeline, type ToolRowView } from '../toolCard';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

function delegationView(blocks: ChatBlock[]): ToolRowView {
  const message: ChatMessage = { id: 'a', sessionId: 's', role: 'assistant', blocks };
  const group = groupTimeline(message).find((item) => item.kind === 'toolGroup');
  if (!group || group.kind !== 'toolGroup') throw new Error('no tool group');
  const row = deriveToolGroupRows(group.entries, { t: zh })[0];
  if (!row) throw new Error('no row');
  return row;
}

const CALL: ChatBlock = {
  id: 'c1',
  type: 'tool_call',
  toolCallId: 'c1',
  toolName: 'Agent',
  toolInput: { description: 'Map the calib code', prompt: 'Look around', subagent_type: 'Explore' },
};
const DONE: ChatBlock = {
  id: 'c1-r',
  type: 'tool_result',
  toolCallId: 'c1',
  toolOk: true,
  toolOutput: 'Found it.',
};
const FAILED: ChatBlock = {
  id: 'c1-r',
  type: 'tool_result',
  toolCallId: 'c1',
  toolOk: false,
  toolOutput: 'Agent crashed: out of memory\nstack…',
};

function lane(patch: Partial<SubagentLane> = {}): SubagentLane {
  return {
    parentToolCallId: 'c1',
    sessionId: 's',
    agentId: 'child-1',
    agentType: 'Explore',
    description: 'Map the calib code',
    status: 'running',
    taskType: null,
    startedAt: 1_000,
    endedAt: null,
    rows: [],
    droppedRows: 0,
    progress: null,
    usage: null,
    report: null,
    pendingPermission: null,
    capped: false,
    ordinal: 1,
    ...patch,
  };
}

const read = (id: string, status: 'running' | 'ok' = 'ok') => ({
  kind: 'tool' as const,
  toolCallId: id,
  name: 'Read',
  input: { file_path: `src/${id}.ts` },
  status,
});

describe('[D212-NAME] the step is named by the subagent’s type', () => {
  it('Explore by its type; general-purpose, or none known, is Agent', () => {
    expect(delegationName('Explore')).toBe('Explore');
    expect(delegationName('general-purpose')).toBe('Agent');
    expect(delegationName(null)).toBe('Agent');
  });

  it('carries what it was asked to do and the child to open', () => {
    const line = deriveDelegationLine(delegationView([CALL]), lane(), zh);
    expect(line.name).toBe('Explore');
    expect(line.description).toBe('Map the calib code');
    expect(line.childId).toBe('child-1');
  });
});

describe('[D212-LINE] the one ⎿ line', () => {
  it('Initializing… before its first call', () => {
    expect(deriveDelegationLine(delegationView([CALL]), lane(), zh).result).toEqual({
      text: 'Initializing…',
      tone: 'muted',
    });
  });

  it('working: its running call, and how many it has made', () => {
    const working = lane({ rows: [read('a'), read('b'), read('c', 'running')] });
    expect(deriveDelegationLine(delegationView([CALL]), working, zh).result.text).toBe(
      'Read(src/c.ts) · 3 tool uses'
    );
    const first = lane({ rows: [read('a', 'running')] });
    expect(deriveDelegationLine(delegationView([CALL]), first, zh).result.text).toBe(
      'Read(src/a.ts)'
    );
  });

  it('waiting on the reader: which call', () => {
    const waiting = lane({ pendingPermission: { toolName: 'Bash' } });
    expect(deriveDelegationLine(delegationView([CALL]), waiting, zh).result.text).toBe(
      zh('Waiting for your approval: {{tool}}', { tool: 'Bash' })
    );
  });

  it('done: Done (12 tool uses · 45.2k tokens · 1m 3s), the CLI’s words', () => {
    const done = lane({
      status: 'completed',
      endedAt: 64_000,
      report: { totalToolUseCount: 12, totalTokens: 45_200, totalDurationMs: 63_000 },
    });
    expect(deriveDelegationLine(delegationView([CALL, DONE]), done, zh).result).toEqual({
      text: 'Done (12 tool uses · 45.2k tokens · 1m 3s)',
      tone: 'muted',
    });
  });

  it('done with nothing measured: what is known, else just Done', () => {
    const counted = lane({ status: 'completed', startedAt: null, rows: [read('a')] });
    expect(deriveDelegationLine(delegationView([CALL, DONE]), counted, zh).result.text).toBe(
      'Done (1 tool use)'
    );
    expect(deriveDelegationLine(delegationView([CALL, DONE]), null, zh).result.text).toBe('Done');
  });

  it('failed: the first line of what came back, in red', () => {
    const failed = lane({ status: 'failed', endedAt: 5_000 });
    expect(deriveDelegationLine(delegationView([CALL, FAILED]), failed, zh).result).toEqual({
      text: 'Agent crashed: out of memory',
      tone: 'bad',
    });
  });

  it('stopped: Interrupted', () => {
    const stopped = lane({ status: 'stopped', endedAt: 5_000 });
    expect(deriveDelegationLine(delegationView([CALL, DONE]), stopped, zh).result.text).toBe(
      'Interrupted'
    );
  });

  it('in the background: its call came back, it still works', () => {
    const line = deriveDelegationLine(
      delegationView([CALL, DONE]),
      lane({ rows: [read('a', 'running')] }),
      zh
    );
    expect(line.background).toBe(true);
    expect(line.result.text).toBe('Read(src/a.ts)');
  });
});

describe('compactTokens', () => {
  it('reads as the CLI counts', () => {
    expect(compactTokens(812)).toBe('812');
    expect(compactTokens(45_200)).toBe('45.2k');
    expect(compactTokens(45_000)).toBe('45k');
    expect(compactTokens(1_200_000)).toBe('1.2M');
  });
});
