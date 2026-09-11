import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexRollout } from '../CodexRollout';

const fixture = readFileSync(
  resolve(
    __dirname,
    '../../../../agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl'
  ),
  'utf8'
);

describe('Codex on-disk rollout reader', () => {
  it('reads captured rollout records and keeps legacy tools display-only', () => {
    const parsed = parseCodexRollout(fixture);
    expect(parsed.workspacePath).toBe('/tmp/codex-import-fixture');
    expect(parsed.entries.some((entry) => entry.kind === 'user')).toBe(true);
    expect(parsed.entries.some((entry) => entry.kind === 'assistant')).toBe(true);
    const tools = parsed.entries.filter((entry) => entry.kind === 'display');
    expect(tools).toHaveLength(2);
    expect(tools[0].toolCallId).toBe(tools[1].toolCallId);
    expect(parsed.entries.some((entry) => entry.kind === 'tool_result')).toBe(false);
    expect(parsed.diagnostics).toContainEqual(
      expect.stringContaining('Encrypted reasoning omitted')
    );
  });

  it('does not duplicate messages from mirrored event records', () => {
    const mirrored = fixture
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line);
        return JSON.stringify({ ...row, type: 'event_msg' });
      })
      .join('\n');
    expect(parseCodexRollout(`${fixture}\n${mirrored}`).entries).toEqual(
      parseCodexRollout(fixture).entries
    );
  });

  it('fails visibly for corrupt input and missing metadata instead of publishing a partial import', () => {
    expect(() => parseCodexRollout(`${fixture}\n{`)).toThrow();
    const withoutHeader = fixture
      .split('\n')
      .filter((line) => !line.includes('session_meta'))
      .join('\n');
    expect(() => parseCodexRollout(withoutHeader)).toThrow('metadata');
  });

  it('uses the existing tool redaction before exposing captured tool input', () => {
    const lines = fixture
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line);
        if (row.type === 'response_item' && row.payload.type === 'custom_tool_call') {
          row.payload.input = 'token=secret-test-value';
        }
        return JSON.stringify(row);
      });
    const parsed = parseCodexRollout(lines.join('\n'));
    expect(JSON.stringify(parsed)).not.toContain('secret-test-value');
  });

  // C1 (H/21): the older shape is still on disk for anyone who used Codex
  // before the `{timestamp,type,payload}` wrapper landed — a bare header line
  // plus bare item rows.
  it('reads the legacy bare-row rollout shape', () => {
    const legacy = [
      { id: 'legacy-session-1', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/tmp/legacy-codex' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for this repo' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '真实的第一句提问' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'legacy answer' }],
      },
      { type: 'function_call', name: 'shell', call_id: 'call-1', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'a.txt' },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');

    const parsed = parseCodexRollout(legacy);
    expect(parsed.sessionId).toBe('legacy-session-1');
    expect(parsed.workspacePath).toBe('/tmp/legacy-codex');
    expect(parsed.entries.filter((entry) => entry.kind === 'user')).toHaveLength(1);
    expect(parsed.entries.find((entry) => entry.kind === 'user')?.text).toBe('真实的第一句提问');
    expect(parsed.entries.some((entry) => entry.kind === 'assistant')).toBe(true);
    expect(parsed.entries.filter((entry) => entry.kind === 'display')).toHaveLength(2);
  });

  it('reports a legacy session with no recorded cwd instead of refusing it', () => {
    const legacy = [
      { id: 'legacy-session-2', timestamp: '2026-09-01T10:00:00.000Z' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');

    const parsed = parseCodexRollout(legacy);
    expect(parsed.workspacePath).toBe('');
    expect(parsed.diagnostics).toContainEqual(expect.stringContaining('no working directory'));
  });
});
