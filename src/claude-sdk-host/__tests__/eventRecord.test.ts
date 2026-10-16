import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRecording, type RawRecording } from '../tools/event-normalize.ts';
import { canonicalSample, firstDifference, RECORDED_SCENARIOS } from '../tools/event-record.ts';

/**
 * Route B S-5 (topic s5-regression.md R-3): what the recorded-event gate keeps and
 * what it drops, so a sample changes only when what the renderer receives does.
 */

const WS = 'C:\\Users\\ann\\AppData\\Local\\Temp\\pilab-record-AbC\\ws';
const raw = (events: RawRecording['events']): RawRecording => ({
  scenario: 'tools',
  workspace: WS,
  configDir: 'C:\\Users\\ann\\AppData\\Local\\Temp\\pilab-record-AbC\\config',
  tmp: 'C:\\Users\\ann\\AppData\\Local\\Temp',
  events,
});

describe('normalizeRecording', () => {
  it('names ids by kind and first appearance, the same id the same everywhere', () => {
    const out = normalizeRecording(
      raw([
        {
          type: 'tool.started',
          payload: { messageId: 'cc-40f2f77f-t2-s1', toolCallId: 'toolu_e5b8', name: 'Write' },
        },
        { type: 'permission.requested', payload: { permissionId: 'toolu_e5b8' } },
        {
          type: 'question.requested',
          payload: { questionId: 'cc-question-toolu_99', review: { callId: 'toolu_99' } },
        },
        { type: 'message.started', payload: { messageId: 'cc-user-3', attemptId: 'attempt-7' } },
      ])
    );
    expect(out.events.map((e) => e.payload)).toEqual([
      { messageId: '<msg#1>', toolCallId: '<call#1>', name: 'Write' },
      { permissionId: '<call#1>' },
      { questionId: '<question#1>', review: { callId: '<call#2>' } },
      { messageId: '<user#1>', attemptId: '<attempt#1>' },
    ]);
  });

  it('names the run directories in every spelling, and the OS', () => {
    const out = normalizeRecording(
      raw([
        {
          type: 'tool.completed',
          payload: {
            output: `cc-proto-bash\n/tmp/pilab-record-AbC/ws\nMINGW64_NT-10.0-19043`,
            path: `${WS}\\sub\\x.txt`,
            other: 'c:/users/ann/appdata/local/temp/pilab-record-AbC/config/plans/p.md',
          },
        },
      ])
    );
    expect(out.events[0].payload).toEqual({
      output: 'cc-proto-bash\n<ws>\n<os>',
      path: '<ws>/sub/x.txt',
      other: '<config>/plans/p.md',
    });
  });

  it('joins a block deltas, keeps the last of repeats, and keeps usage only as keys', () => {
    const out = normalizeRecording(
      raw([
        { type: 'session.status', payload: { status: 'running', backgroundTasks: 0 } },
        { type: 'session.status', payload: { status: 'running', backgroundTasks: 0 } },
        { type: 'message.delta', payload: { messageId: 'cc-user-1', blockId: 'b', text: 'Hel' } },
        { type: 'usage.updated', payload: { input: 1200, output: 5, pending: true } },
        { type: 'message.delta', payload: { messageId: 'cc-user-1', blockId: 'b', text: 'lo' } },
        { type: 'tool.updated', payload: { toolCallId: 'toolu_1', input: { a: 1 } } },
        { type: 'tool.updated', payload: { toolCallId: 'toolu_1', input: { a: 2 } } },
        { type: 'session.status', payload: { status: 'idle', backgroundTasks: 0 } },
      ])
    );
    expect(out.events).toEqual([
      { type: 'session.status', payload: { status: 'running', backgroundTasks: 0 } },
      { type: 'message.delta', payload: { messageId: '<user#1>', blockId: 'b', text: 'Hello' } },
      { type: 'tool.updated', payload: { toolCallId: '<call#1>', input: { a: 2 } } },
      { type: 'session.status', payload: { status: 'idle', backgroundTasks: 0 } },
    ]);
    expect(out.usageKeys).toEqual(['input', 'output', 'pending']);
  });
});

describe('the recorded-event gate', () => {
  it('compares content, not the layout a formatter gave the committed sample', () => {
    const recorded = `${JSON.stringify({ choices: ['a', 'b'], n: 1 }, null, 2)}\n`;
    // As the commit hook leaves it: short arrays on one line, Windows line ends.
    const reflowed = ['{', '  "choices": ["a", "b"],', '  "n": 1', '}', ''].join('\r\n');
    expect(canonicalSample(reflowed)).toBe(recorded);
    expect(firstDifference(canonicalSample(reflowed), recorded)).toBeNull();
  });

  it('reports the first differing line', () => {
    expect(firstDifference('a\nb\nc', 'a\nb\nc')).toBeNull();
    expect(firstDifference('a\nb\nc', 'a\nX\nc')).toBe('line 2\n  expected: b\n  recorded: X');
    expect(firstDifference('a\nb', 'a\nb\nc')).toBe('line 3\n  expected: (end)\n  recorded: c');
  });

  it('has a committed sample for every recorded scenario, with nothing of the run left in it', () => {
    const dir = join(__dirname, '..', '..', 'shared', '__tests__', 'fixtures', 'claude-sdk');
    const files = readdirSync(dir).sort();
    expect(files).toEqual(RECORDED_SCENARIOS.map((s) => `stream.${s}.json`).sort());
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      const sample = JSON.parse(text) as { events: Array<{ type: string }> };
      expect(
        sample.events.some((e) => e.type === 'session.completed'),
        file
      ).toBe(true);
      // No raw id, absolute path or temp directory survived normalization.
      expect(text, file).not.toMatch(
        /toolu_[0-9a-z]|cc-[0-9a-f]{8}-t|[A-Za-z]:\\\\|pilab-record-|attempt-\d/
      );
    }
  });
});
