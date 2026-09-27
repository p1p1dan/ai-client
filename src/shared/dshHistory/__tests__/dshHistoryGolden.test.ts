import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  HistoryMessage,
  SessionHistoryPage,
  SessionTreeSnapshot,
} from '../../types/sessionHistory.ts';
import { paginateHistory } from '../page.ts';
import { INTERRUPTED_TURN_NOTICE_KEY, projectDshHistory } from '../projection.ts';
import { buildDshSessionTree, dshLeafCheckpoint } from '../tree.ts';
import type { DshLogEvent } from '../types.ts';

/**
 * dsh-rebase P1-4a / P1-4e — the projection against real DSH logs.
 *
 * `src/dsh-host/tools/bridge-record.ts` drove the product bridge through a real
 * DSH host and the fake gateway and saved, per scenario, the session's DSH log
 * (`log.*.json`, read as the bridge reads it) and what the bridge answered
 * over worker RPC (`rpc.*.json`), normalized with ONE id map. So projecting
 * the log here must give exactly the page, tree and leaf the live bridge —
 * which folded the same events one at a time — gave Main.
 *
 * The recorder writes timestamps as `<ms>` and drops `settledAt` (its presence
 * hangs on two events sharing a millisecond); the log's times are rebuilt
 * from seq, which keeps their order, and the projection's output is
 * normalized the same way before comparing.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '__tests__',
  'fixtures',
  'dsh'
);
const T0 = 1_790_000_000_000;

interface LogSample {
  header: { id: string };
  cursor: number;
  events: Array<Omit<DshLogEvent, 'time'> & { time: unknown }>;
}

interface RpcSample {
  bootstrap: Array<{ initialHistory?: { page: SessionHistoryPage } }>;
  history: {
    page: SessionHistoryPage;
    logicalSessionId: string;
    sessionFile: string;
    workspacePath: string;
  };
  tree: { snapshot: SessionTreeSnapshot };
}

function read<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as T;
}

/** What the recorder does to the bridge's answers: epoch ms -> `<ms>`, no `settledAt`. */
function normalized(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1e12 && value < 1e13 ? '<ms>' : value;
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'settledAt')
        .map(([key, item]) => [key, normalized(item)])
    );
  }
  return value;
}

const scenarios = readdirSync(FIXTURES)
  .filter((file) => /^log\..+\.json$/.test(file))
  .map((file) => file.slice('log.'.length, -'.json'.length))
  .sort();

function project(name: string) {
  const log = read<LogSample>(`log.${name}.json`);
  const rpc = read<RpcSample>(`rpc.${name}.json`);
  const events = log.events.map((event) => ({ ...event, time: T0 + event.seq }) as DshLogEvent);
  return { log, rpc, messages: projectDshHistory(events) };
}

function blocksOf(messages: readonly HistoryMessage[]) {
  return messages.flatMap((message) => message.blocks);
}

it('finds every recorded scenario (a walker that found none would pass everything)', () => {
  expect(scenarios).toEqual([
    'compact',
    'crash-resume',
    'fail',
    'stop-stream',
    'stop-tool',
    'stream',
    'tool',
  ]);
  for (const name of scenarios) {
    expect(readdirSync(FIXTURES)).toContain(`rpc.${name}.json`);
    expect(readdirSync(FIXTURES)).toContain(`stream.${name}.json`);
  }
});

describe.each(scenarios)('the %s recording', (name) => {
  it('projects the page the bridge answered', () => {
    const { rpc, messages } = project(name);
    const { offset, limit } = rpc.history.page;
    expect(normalized(paginateHistory(messages, offset, limit))).toEqual(rpc.history.page);
  });

  it('builds the tree and leaf the bridge answered', () => {
    const { log, rpc, messages } = project(name);
    const { logicalSessionId, sessionFile, workspacePath } = rpc.tree.snapshot;
    const snapshot = buildDshSessionTree({
      chains: [{ messages, current: true }],
      logicalSessionId,
      sessionFile,
      workspacePath,
      leaf: dshLeafCheckpoint(messages, log.header.id, log.cursor),
    });
    expect(normalized(snapshot)).toEqual(rpc.tree.snapshot);
  });

  it('gave a reopened session that same first page', () => {
    const { rpc, messages } = project(name);
    for (const boot of rpc.bootstrap) {
      if (!boot.initialHistory) continue;
      const { offset, limit } = boot.initialHistory.page;
      expect(normalized(paginateHistory(messages, offset, limit))).toEqual(
        boot.initialHistory.page
      );
    }
  });
});

describe('what the recordings show a user', () => {
  it('stream / tool: a bubble, then the step messages with their tool row', () => {
    expect(project('stream').messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    const tool = project('tool').messages;
    expect(tool.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(blocksOf(tool).map((block) => block.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'text',
    ]);
  });

  it('fail: an incomplete error placeholder after the prompt', () => {
    const [, placeholder] = project('fail').messages;
    expect(placeholder).toMatchObject({
      role: 'assistant',
      blocks: [],
      incomplete: true,
      stopReason: 'error',
    });
    expect(placeholder?.id.endsWith(':end')).toBe(true);
  });

  it('stop-stream: the streamed prefix, incomplete, stopped by the user', () => {
    const [, step] = project('stop-stream').messages;
    expect(step).toMatchObject({ incomplete: true, stopReason: 'aborted', stopCause: 'user_stop' });
    const text = step?.blocks[0];
    expect(text?.type === 'text' && text.text.startsWith('STREAMED-stop-stream')).toBe(true);
  });

  it('stop-tool: the running command settled as stopped', () => {
    const [, step] = project('stop-tool').messages;
    expect(step?.stopCause).toBe('user_stop');
    expect(step?.blocks.at(-1)).toMatchObject({ type: 'tool_result', ok: false, stopped: true });
  });

  it('compact: both turns stay, then a Context summary row', () => {
    const messages = project('compact').messages;
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'assistant',
      'system',
    ]);
    const last = messages.at(-1)?.blocks[0];
    expect(
      last?.type === 'text' && last.text.startsWith('Context summary\n\n## Primary Request')
    ).toBe(true);
  });

  it('crash-resume: an outcome-unknown tool row and the interrupted-turn note (decision 032)', () => {
    const messages = project('crash-resume').messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'system']);
    expect(messages[1]).toMatchObject({ incomplete: true, stopReason: 'interrupted' });
    expect(messages[1]?.blocks.at(-1)).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(messages[2]?.blocks[0]).toMatchObject({ notice: { key: INTERRUPTED_TURN_NOTICE_KEY } });
  });
});
