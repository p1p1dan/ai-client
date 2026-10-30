import { describe, expect, it } from 'vitest';
import {
  createLegacyHistoryEvents,
  pilabReplayScenarios,
} from './fixtures/pilabExperience';

const scenario = (id: string) => {
  const found = pilabReplayScenarios.find((item) => item.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
};

describe('PiLab experience replay fixtures', () => {
  it('provides all F01-F08 scenarios with deterministic, session-scoped event identities', () => {
    expect(pilabReplayScenarios.map((item) => item.id)).toEqual([
      'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08',
    ]);
    for (const item of pilabReplayScenarios) {
      const first = item.createEvents();
      const second = item.createEvents();
      expect(first).toEqual(second);
      expect(first.length).toBeGreaterThan(0);
      expect(first.map((event) => event.seq)).toEqual(
        Array.from({ length: first.length }, (_, index) => index + 1)
      );
      expect(new Set(first.map((event) => event.sessionId)).size).toBe(1);
      expect(first.every((event) => event.sessionId?.startsWith('pilab-replay-'))).toBe(true);
      expect(item.ac.length).toBeGreaterThan(0);
      expect(item.source).toBe('constructed-sanitized');
    }
  });

  it('F02 preserves the requested structure rather than deduplicating by text', () => {
    const events = scenario('F02').createEvents();
    expect(events.filter((event) => event.type === 'thinking.started')).toHaveLength(42);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(67);
    const answerBlocks = new Set(
      events.flatMap((event) =>
        event.type === 'message.delta' && event.payload.messageId === 'long-assistant'
          ? [event.payload.blockId]
          : []
      )
    );
    expect(answerBlocks.size).toBe(8);
  });

  it('F04 separates legal equal deltas from equal commands with different call ids', () => {
    const events = scenario('F04').createEvents();
    const deltas = events.filter((event) => event.type === 'message.delta' && event.payload.text === '好');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].seq).not.toBe(deltas[1].seq);
    const calls = events.filter((event) => event.type === 'tool.started');
    expect(calls.map((event) => event.payload.toolCallId)).toEqual(['repeat-1', 'repeat-2']);
    expect(calls.map((event) => event.payload.input)).toEqual([
      { command: 'pnpm test' }, { command: 'pnpm test' },
    ]);
  });

  it('F07 contains exactly 10k events, 100 calls and at least 1MB of tool output', () => {
    const events = scenario('F07').createEvents();
    expect(events).toHaveLength(10_000);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(100);
    const outputBytes = events.reduce((total, event) => {
      if (event.type !== 'tool.completed' || typeof event.payload.output !== 'string') return total;
      return total + Buffer.byteLength(event.payload.output, 'utf8');
    }, 0);
    expect(outputBytes).toBeGreaterThanOrEqual(1_000_000);
  });

  it('F08 replays both supported engines without adding new history fields', () => {
    for (const engine of ['dsh', 'claude-sdk'] as const) {
      const events = createLegacyHistoryEvents(engine);
      const resumed = events.find((event) => event.type === 'session.resumed');
      expect(resumed?.type).toBe('session.resumed');
      if (resumed?.type === 'session.resumed') {
        expect(resumed.payload?.engine).toBe(engine === 'claude-sdk' ? engine : undefined);
      }
      const history = events.find((event) => event.type === 'session.history');
      expect(history?.type).toBe('session.history');
      if (history?.type === 'session.history') {
        expect(history.payload.messages[1].incomplete).toBe(true);
        expect(history.payload.messages[1]).not.toHaveProperty('transcriptId');
      }
    }
  });
});
