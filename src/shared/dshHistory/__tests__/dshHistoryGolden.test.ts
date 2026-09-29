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
  /** P1-4b rewind: the sessions the stub's lineage retired, oldest first. */
  retired?: LogSample[];
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

/**
 * dsh-rebase P1-7b: the bridge clips a tree node's preview (`…`) BEFORE the
 * recorder renumbers the UUIDs inside it, and `id-N` is shorter than a UUID —
 * so a clipped preview that carries one (a subagent's settlement head names
 * its child, `sub-cont`) reads shorter in the sample than the text the
 * projection of the normalized log gives. Such a preview is taken as the
 * prefix it is; every other field, and every other preview, must match.
 */
function withRecorderClipping(
  built: SessionTreeSnapshot,
  answered: SessionTreeSnapshot
): SessionTreeSnapshot {
  return {
    ...built,
    nodes: built.nodes.map((node, index) => {
      const clipped = answered.nodes[index]?.preview;
      return clipped?.endsWith('…') &&
        node.preview !== clipped &&
        node.preview?.startsWith(clipped.slice(0, -1))
        ? { ...node, preview: clipped }
        : node;
    }),
  };
}

const scenarios = readdirSync(FIXTURES)
  .filter((file) => /^log\..+\.json$/.test(file))
  .map((file) => file.slice('log.'.length, -'.json'.length))
  .sort();

/**
 * `live`: the log of the session the bridge had open, whose cache names the
 * live copy of each row (P1-4d1, `liveMessageId`); a retired session's
 * timeline is read without.
 */
function projectLog(log: LogSample, live = false): HistoryMessage[] {
  return projectDshHistory(
    log.events.map((event) => ({ ...event, time: T0 + event.seq }) as DshLogEvent),
    live ? { liveSessionId: log.header.id } : {}
  );
}

function project(name: string) {
  const log = read<LogSample>(`log.${name}.json`);
  const rpc = read<RpcSample>(`rpc.${name}.json`);
  return { log, rpc, messages: projectLog(log, true) };
}

function blocksOf(messages: readonly HistoryMessage[]) {
  return messages.flatMap((message) => message.blocks);
}

it('finds every recorded scenario (a walker that found none would pass everything)', () => {
  expect(scenarios).toEqual([
    'compact',
    'crash-resume',
    'fail',
    'fail-retry',
    'file-attach',
    'fork',
    'image',
    'job-notice',
    // P1-7b (decisions 069, 119): recorded by the orchestrator at close-out.
    'jobs-kill',
    'perm-card',
    'perm-deny',
    'perm-gear',
    'perm-grants',
    'perm-plan',
    'perm-restart',
    'perm-search',
    'perm-stop',
    'perm-subagent',
    // P1-4d3 (decisions 098, 114): recorded by the orchestrator at close-out.
    'question',
    'rewind',
    'steer',
    'stop-stream',
    'stop-tool',
    'stream',
    // P1-7b (decisions 069, 119): recorded by the orchestrator at close-out.
    'sub-cont',
    'think',
    'tool',
    'usage',
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
      // A rewound session's tree merges the sessions it retired (decision 026).
      chains: [
        ...(log.retired ?? []).map((retired) => ({
          messages: projectLog(retired),
          current: false,
        })),
        { messages, current: true },
      ],
      logicalSessionId,
      sessionFile,
      workspacePath,
      leaf: dshLeafCheckpoint(messages, log.header.id, log.cursor),
    });
    expect(
      withRecorderClipping(normalized(snapshot) as SessionTreeSnapshot, rpc.tree.snapshot)
    ).toEqual(rpc.tree.snapshot);
  });

  it('gave a reopened session that same first page', () => {
    const { rpc, messages } = project(name);
    for (const boot of rpc.bootstrap) {
      if (!boot.initialHistory) continue;
      const { offset, limit, totalCount } = boot.initialHistory.page;
      // A reopen can be followed by more turns (perm-restart): the page is the
      // history as it stood then, a prefix of the final log's.
      const then = messages.slice(0, totalCount);
      expect(normalized(paginateHistory(then, offset, limit))).toEqual(boot.initialHistory.page);
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

  function texts(messages: readonly HistoryMessage[]): string[] {
    return messages.map((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    );
  }

  it('rewind (P1-4b): the timeline goes on from the first answer; the dropped turn is a retired branch', () => {
    const { log, rpc, messages } = project('rewind');
    expect(texts(messages)).toEqual([
      'alpha REWIND-KEEP-1, no scenario.',
      'fake gateway: no P0 scenario marker',
      'P0-RECALL {"markers":["REWIND-KEEP-1","REWIND-DROP-2"]} which markers do you see?',
      'P0-RECALL present=REWIND-KEEP-1 missing=REWIND-DROP-2',
    ]);
    // The child inherited the first turn with the same ids.
    const retired = projectLog(log.retired?.[0] as LogSample);
    expect(retired.slice(0, 2).map((message) => message.id)).toEqual(
      messages.slice(0, 2).map((message) => message.id)
    );
    const dropped = rpc.tree.snapshot.nodes.filter((node) => !node.active);
    expect(dropped.map((node) => node.preview)).toEqual([
      'beta REWIND-DROP-2, no scenario.',
      'fake gateway: no P0 scenario marker',
    ]);
  });

  it('fork (P1-4b): the child holds the path to the fork point, then its own turn', () => {
    const { log, messages } = project('fork');
    expect(log.header).toMatchObject({ id: 'aiclient-rec-fork-child', isSeeded: true });
    expect(texts(messages)).toEqual([
      'gamma FORK-BASE-1, no scenario.',
      'fake gateway: no P0 scenario marker',
      'P0-RECALL {"markers":["FORK-BASE-1","FORK-AFTER-2"]} which markers do you see?',
      'P0-RECALL present=FORK-BASE-1 missing=FORK-AFTER-2',
    ]);
  });

  it('image (P1-4c2): the prompt carries the chip of its image, and the model got the image', () => {
    const { messages } = project('image');
    expect(messages[0]).toMatchObject({
      role: 'user',
      attachments: [{ kind: 'image', mediaType: 'image/png', name: 'dot.png' }],
    });
    expect(texts(messages)).toEqual([
      'P1-IMAGE: what do you see?',
      'P1-IMAGE saw 1 image block(s).',
    ]);
  });

  it('file-attach (P1-4c2): the bubble keeps the words, the chip names the file, the model read it', () => {
    const { messages } = project('file-attach');
    expect(messages[0]).toMatchObject({
      role: 'user',
      attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'notes.txt' }],
    });
    // Decision 097: the file is not merged into the prompt.
    expect(texts(messages)[0]).toBe('P1-FILEREAD: read the attached notes.');
    expect(texts(messages).at(-1)).toBe('P1-FILEREAD read: FILE-MARKER-NOTES.');
    const read = blocksOf(messages).find((block) => block.type === 'tool_call');
    expect(read).toMatchObject({ name: 'read' });
  });
});
