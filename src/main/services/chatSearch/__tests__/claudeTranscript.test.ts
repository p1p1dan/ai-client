import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SDK_WINDOW_OWNED_COMMANDS,
  commandRowLine as sdkCommandRowLine,
  localCommandOutput as sdkLocalCommandOutput,
} from '../../../../claude-sdk-host/slashCommands';
import {
  CLI_MARKER_TEXT,
  COMPACT_SUMMARY_PREFIX,
  claudeTranscriptMessages,
  commandRowLine,
  localCommandOutput,
} from '../claudeTranscript';

/**
 * The Agent SDK chat's searchable messages, read from the CLI transcript the
 * way `sdkSessionRuntime.ts` `readTranscript` names them after
 * `getSessionMessages` (0.3.300) built the chain. The fixture covers the
 * shapes a real transcript has; a local run against 37 real Claude Code
 * transcripts matched the SDK's chain row for row (prose rows).
 */

let clock = 0;
function row(fields: Record<string, unknown>): string {
  clock += 1;
  return JSON.stringify({
    isSidechain: false,
    sessionId: 'cc-1',
    timestamp: new Date(Date.UTC(2026, 9, 29, 0, 0, clock)).toISOString(),
    ...fields,
  });
}
const user = (uuid: string, parentUuid: string | null, content: unknown, extra = {}) =>
  row({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, ...extra });
const assistant = (uuid: string, parentUuid: string, id: string, content: unknown[], extra = {}) =>
  row({
    type: 'assistant',
    uuid,
    parentUuid,
    message: { role: 'assistant', id, model: 'claude-x', content },
    ...extra,
  });

function fixture(): string {
  clock = 0;
  return [
    row({ type: 'queue-operation', operation: 'enqueue' }),
    user('u1', null, '请做一份批次良率分析'),
    // One API message split over two rows (text, then a tool call).
    assistant('a1', 'u1', 'msg_1', [
      { type: 'thinking', thinking: 'secret thinking 8GE21E15' },
      { type: 'text', text: '先读取 Lot 8GE21E15 的数据。' },
    ]),
    assistant('a1b', 'a1', 'msg_1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
    user('r1', 'a1b', [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'TOOL OUTPUT 8GE21E15' },
    ]),
    assistant('a2', 'r1', 'msg_2', [{ type: 'text', text: 'Yield is 97%.' }]),
    // An abandoned branch: a rewind re-sent from u1's reply.
    user('old', 'a2', 'abandoned question'),
    assistant('old-a', 'old', 'msg_old', [{ type: 'text', text: 'abandoned answer' }]),
    user('u2', 'a2', 'Second Question about WAFER maps'),
    user('marker', 'u2', [{ type: 'text', text: '[Request interrupted by user]' }]),
    user('meta', 'marker', 'skill body injected by the CLI', { isMeta: true }),
    user(
      'cmd',
      'meta',
      '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src/a.ts</command-args>'
    ),
    user('cmd-out', 'cmd', '<local-command-stdout>local output text</local-command-stdout>'),
    user('compact-cmd', 'cmd-out', '<command-name>/compact</command-name>'),
    user('summary', 'compact-cmd', `${COMPACT_SUMMARY_PREFIX} summary text`, {
      isCompactSummary: true,
    }),
    user('side', 'summary', 'sidechain text', { isSidechain: true }),
    row({
      type: 'attachment',
      uuid: 'q1',
      parentUuid: 'summary',
      attachment: { type: 'queued_command', prompt: 'mid-turn note', source_uuid: 'src-q1' },
    }),
    assistant('a3', 'q1', 'msg_3', [{ type: 'text', text: 'Noted.' }]),
    user('notify', 'a3', '<task-notification><summary>Agent done</summary></task-notification>'),
    assistant('a4', 'notify', 'msg_4', [{ type: 'text', text: 'Final reply' }]),
    '{"torn',
  ].join('\n');
}

describe('claudeTranscriptMessages', () => {
  it('keys each message as the timeline does and keeps only prose', () => {
    const messages = claudeTranscriptMessages(fixture());
    expect(messages.map((m) => [m.key, m.role, m.text])).toEqual([
      ['h:u1', 'user', '请做一份批次良率分析'],
      ['h:a1', 'assistant', '先读取 Lot 8GE21E15 的数据。'],
      ['h:a2', 'assistant', 'Yield is 97%.'],
      ['h:u2', 'user', 'Second Question about WAFER maps'],
      ['h:cmd', 'user', '/review src/a.ts'],
      ['h:src-q1', 'user', 'mid-turn note'],
      ['h:a3', 'assistant', 'Noted.'],
      ['h:a4', 'assistant', 'Final reply'],
    ]);
    expect(messages[0]?.timestamp).toBe(Date.UTC(2026, 9, 29, 0, 0, 2));
  });

  it('never indexes tool output, thinking, the abandoned branch or sidechains', () => {
    const all = claudeTranscriptMessages(fixture())
      .map((m) => m.text)
      .join('\n');
    for (const absent of [
      'TOOL OUTPUT',
      'secret thinking',
      'abandoned',
      'sidechain text',
      'local output text',
      'skill body',
      'summary text',
      'Agent done',
    ]) {
      expect(all).not.toContain(absent);
    }
  });

  it('puts the text of a parallel tool-call sibling under its API message', () => {
    clock = 0;
    const raw = [
      user('u', null, 'go'),
      assistant('x1', 'u', 'msg_p', [{ type: 'text', text: 'part one' }]),
      // The sibling hangs off x1 but the chain continues through x2.
      assistant('x1b', 'x1', 'msg_p', [{ type: 'text', text: 'part two' }]),
      assistant('x2', 'x1', 'msg_p', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
      user('res', 'x2', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      assistant('y', 'res', 'msg_q', [{ type: 'text', text: 'done' }]),
    ].join('\n');
    expect(claudeTranscriptMessages(raw).map((m) => [m.key, m.text])).toEqual([
      ['h:u', 'go'],
      ['h:x1', 'part one\npart two'],
      ['h:y', 'done'],
    ]);
  });

  it('returns nothing for an empty or foreign file', () => {
    expect(claudeTranscriptMessages('')).toEqual([]);
    expect(claudeTranscriptMessages('not json\n{"type":"summary"}')).toEqual([]);
  });
});

describe('the SDK host rules this file copies', () => {
  it('reads command rows and local output as slashCommands.ts does', () => {
    const samples = [
      '<command-name>/review</command-name><command-args>x y</command-args>',
      '<command-message>skill</command-message><command-name>skill</command-name>',
      '<command-name></command-name>',
      '<local-command-stdout>hi</local-command-stdout>',
      '<local-command-stderr>  </local-command-stderr>',
      'plain text',
    ];
    for (const sample of samples) {
      expect(commandRowLine(sample)).toEqual(sdkCommandRowLine(sample));
      expect(localCommandOutput(sample)).toEqual(sdkLocalCommandOutput(sample));
    }
    expect([...SDK_WINDOW_OWNED_COMMANDS]).toEqual(['compact']);
  });

  it('uses the marker and summary rules of sdkSessionRuntime.ts', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../claude-sdk-host/sdkSessionRuntime.ts'
      ),
      'utf8'
    );
    expect(source).toContain(`const CLI_MARKER_TEXT = ${CLI_MARKER_TEXT.toString()};`);
    expect(source).toContain(`const COMPACT_SUMMARY_PREFIX = '${COMPACT_SUMMARY_PREFIX}';`);
    // The projection names rows `h:<uuid>`, which the keys here assume.
    expect(source).toMatch(/id: `h:\$\{entry\.uuid\}`,/);
  });
});
