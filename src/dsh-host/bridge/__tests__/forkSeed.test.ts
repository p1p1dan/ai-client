import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import {
  buildDshForkSeed,
  DshForkBoundaryError,
  forkedTurnClosers,
  planDshCut,
} from '../forkSeed.ts';

/**
 * dsh-rebase P1-4b — where a rewind or a fork cuts a DSH log, and the seed
 * the child starts from (decision 027 rule 2; plan P1-4 shard 03 §4-§5), over
 * the logs `tools/bridge-record.ts` recorded from a real host.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../shared/__tests__/fixtures/dsh');
const DSH_SESSION = resolve(HERE, '../../node_modules/@deepseek-ai/dsh-session/lib/index.js');

function log(name: string): DshLogEvent[] {
  return (
    JSON.parse(readFileSync(join(FIXTURES, `log.${name}.json`), 'utf8')) as {
      events: DshLogEvent[];
    }
  ).events;
}

const at = (seq: number, type: string, data: unknown = {}): DshLogEvent => ({
  type,
  seq,
  time: 1_790_000_000_000 + seq,
  data,
});

describe('planDshCut — rewind', () => {
  it('cuts before the turn of a prompt, and hands the prompt back', () => {
    // The second turn's prompt: its turn starts at 17, queued at 16.
    expect(planDshCut(log('compact'), 'id-6', 'rewind')).toEqual({
      boundary: 15,
      editorText: 'P0-TOOL: list the workspace.',
    });
  });

  it('answers an empty child for the first prompt: setup events are not history', () => {
    expect(planDshCut(log('tool'), 'id-1', 'rewind')).toEqual({
      boundary: null,
      editorText: 'P0-TOOL: list the workspace.',
    });
  });

  it('keeps a model step with its tool results, through its step end', () => {
    // Step 1 of two: its step/end, not the turn's.
    expect(planDshCut(log('tool'), 'id-6', 'rewind')).toEqual({ boundary: 16 });
  });

  it('keeps how the turn ended when the step was its last', () => {
    expect(planDshCut(log('tool'), 'id-9', 'rewind')).toEqual({ boundary: 20 });
    // A Stop: the child still reads user_stop on that step.
    const stopped = log('stop-tool');
    expect(planDshCut(stopped, 'id-6', 'rewind')).toEqual({ boundary: 17 });
    expect(stopped[17]?.data).toMatchObject({ reason: { kind: 'aborted' } });
  });

  it('cuts at the turn end for the rows a turn end made', () => {
    expect(planDshCut(log('crash-resume'), 'id-1:interrupted', 'rewind')).toEqual({
      boundary: 17,
    });
    expect(planDshCut(log('fail'), 'id-1:end', 'rewind')).toEqual({ boundary: 15 });
  });

  it('keeps a compaction whole: through its end and its command', () => {
    const events = log('compact');
    const checkpoint = events.find(
      (event) =>
        event.type === 'user/message' &&
        (event.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint'
    );
    const id = (checkpoint?.data as { id: string }).id;
    expect(planDshCut(events, id, 'rewind')).toEqual({ boundary: 34 });
    expect(events[34]?.type).toBe('command/done');
  });

  it('answers undefined for a node the log does not have', () => {
    expect(planDshCut(log('tool'), 'nowhere', 'rewind')).toBeUndefined();
  });

  it('steps back past input still queued in the inbox: the child would run it', () => {
    const events = [
      at(0, 'turn/start', { turn: 1 }),
      at(1, 'step/start', { turn: 1, step: 1 }),
      at(2, 'user/message', { id: 'u1', source: { kind: 'user' }, content: [] }),
      at(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', content: [] } }),
      // A job notice queued for the next step while the step was closing.
      at(4, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ id: 'n1' }] }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'step/start', { turn: 1, step: 2 }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
    ];
    expect(planDshCut(events, 'a1', 'rewind')).toEqual({ boundary: 3 });
  });
});

describe('planDshCut — fork', () => {
  it('keeps the prompt itself', () => {
    expect(planDshCut(log('tool'), 'id-1', 'fork')).toEqual({ boundary: 8 });
  });

  it('cuts a step as a rewind does', () => {
    expect(planDshCut(log('tool'), 'id-6', 'fork')).toEqual({ boundary: 16 });
  });
});

describe('buildDshForkSeed', () => {
  it('copies the prefix and marks the inherited cut', () => {
    const events = log('tool');
    const seed = buildDshForkSeed(events, 20);
    expect(seed.slice(0, 21)).toEqual(events.slice(0, 21));
    // The same objects: every MessageId survives the cut.
    expect(seed[13]).toBe(events[13]);
    expect(seed.slice(21)).toEqual([
      { type: 'session/end-seed', seq: 21, time: events[20]?.time, data: { inherited: true } },
    ]);
  });

  it('closes a turn the cut left open between steps', () => {
    const events = log('tool');
    expect(
      buildDshForkSeed(events, 16)
        .slice(16)
        .map((event) => [event.seq, event.type, event.data])
    ).toEqual([
      [16, 'step/end', { turn: 1, step: 1 }],
      [17, 'session/end-seed', { inherited: true }],
      [18, 'turn/end', { turn: 1, reason: { kind: 'forked' } }],
    ]);
  });

  it('answers a call the cut left unanswered: not started, or outcome unknown', () => {
    const events = log('tool');
    const beforeDispatch = buildDshForkSeed(events, 13).slice(14);
    expect(beforeDispatch.map((event) => event.type)).toEqual([
      'session/end-seed',
      'tool/result',
      'step/end',
      'turn/end',
    ]);
    expect(beforeDispatch[1]).toMatchObject({
      seq: 15,
      data: {
        message: { toolCallId: 'toolu_id-4', isError: true },
        error: { code: 'TOOL_NOT_STARTED' },
      },
      surfaceOp: 'append',
    });
    const dispatched = buildDshForkSeed(events, 14).slice(15);
    expect(dispatched[1]).toMatchObject({
      data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' } },
      sourceEventSeqs: [14],
    });
  });

  it('adds nothing to a balanced log', () => {
    expect(forkedTurnClosers(log('tool'))).toEqual([]);
    expect(forkedTurnClosers([])).toEqual([]);
  });

  it('refuses a boundary that names no event', () => {
    const events = log('tool');
    expect(() => buildDshForkSeed(events, -1)).toThrow(DshForkBoundaryError);
    expect(() => buildDshForkSeed(events, events.length)).toThrow(DshForkBoundaryError);
    expect(() => buildDshForkSeed(events, 1.5)).toThrow(DshForkBoundaryError);
  });
});

/**
 * The copy must not drift from dsh-session's `buildForkSeed` (the bundled
 * bridge cannot import it). Only where src/dsh-host is installed; the real
 * host run (`tools/rewind-experiments.ts`) compares them too.
 */
describe.skipIf(!existsSync(DSH_SESSION))('buildDshForkSeed against dsh-session', () => {
  it('equals buildForkSeed at every boundary of every recorded log', async () => {
    const dsh = (await import(pathToFileURL(DSH_SESSION).href)) as {
      buildForkSeed(events: readonly DshLogEvent[], boundary: number): DshLogEvent[];
    };
    let compared = 0;
    for (const name of [
      'stream',
      'tool',
      'fail',
      'stop-stream',
      'stop-tool',
      'compact',
      'crash-resume',
    ]) {
      const events = log(name);
      for (let boundary = 0; boundary < events.length; boundary += 1) {
        expect(JSON.stringify(buildDshForkSeed(events, boundary)), `${name}@${boundary}`).toBe(
          JSON.stringify(dsh.buildForkSeed(events, boundary))
        );
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});
