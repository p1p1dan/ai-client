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
});
