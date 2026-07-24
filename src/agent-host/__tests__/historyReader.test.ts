import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HISTORY_BLOCK_TEXT_CAP_CHARS,
  HISTORY_INPUT_TAIL_LIMIT_BYTES,
  HISTORY_MAX_MESSAGES,
  HISTORY_OUTPUT_BUDGET_CHARS,
  HISTORY_USER_TEXT_CAP_CHARS,
  listSessionHistory,
  readSessionHistory,
} from '../historyReader.ts';

// TSD magic mirrored from src/main/utils/tsdSafeRead.ts — used to build a
// fixture that looks TSD-encrypted from the Host's point of view.
const TSD_MAGIC = '%TSD-Header-###%';

/** Same forward-munge algorithm the reader uses, kept independent for assertions. */
function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

let root: string;
let claudeConfigDir: string;
let projectsDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'historyReader-'));
  claudeConfigDir = path.join(root, '.claude');
  projectsDir = path.join(claudeConfigDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSession(
  workspacePath: string,
  fileName: string,
  lines: string[]
): Promise<string> {
  const dir = path.join(projectsDir, mungeCwd(workspacePath));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
  return filePath;
}

const WORKSPACE = 'D:\\Code\\projects\\ai-client';

describe('readSessionHistory', () => {
  it('returns jsonl_not_found when no matching file exists', async () => {
    const result = await readSessionHistory({
      workspacePath: WORKSPACE,
      runtimeIdentity: 'missing-session',
      claudeConfigDir,
    });
    expect(result.error?.code).toBe('jsonl_not_found');
    expect(result.messages).toEqual([]);
    expect(result.parseStats).toEqual({ totalLines: 0, controlLines: 0, badLines: 0 });
  });

  it('returns encrypted_unreadable when the file starts with the TSD magic header', async () => {
    const dir = path.join(projectsDir, mungeCwd(WORKSPACE));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'sess-tsd.jsonl'),
      `${TSD_MAGIC}\x00\x00\x00rest-of-encrypted-bytes`,
      'utf-8'
    );

    const result = await readSessionHistory({
      workspacePath: WORKSPACE,
      runtimeIdentity: 'sess-tsd',
      claudeConfigDir,
    });
    expect(result.error?.code).toBe('encrypted_unreadable');
    expect(result.messages).toEqual([]);
  });

  it('finds the file via cross-directory filename scan when the munged dir name does not match', async () => {
    // Directory intentionally does NOT match mungeCwd(WORKSPACE) — simulates a
    // workspace path whose munge diverges from the actual on-disk project dir.
    const oddDir = path.join(projectsDir, 'some-unrelated-dir-name');
    await mkdir(oddDir, { recursive: true });
    await writeFile(
      path.join(oddDir, 'sess-fallback.jsonl'),
      `${line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-20T10:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'Found via fallback scan' },
      })}\n`,
      'utf-8'
    );

    const result = await readSessionHistory({
      workspacePath: WORKSPACE,
      runtimeIdentity: 'sess-fallback',
      claudeConfigDir,
    });
    expect(result.error).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].blocks[0]).toMatchObject({
      type: 'text',
      text: 'Found via fallback scan',
    });
  });

  it('matches the candidate directory case-insensitively', async () => {
    const munged = mungeCwd(WORKSPACE);
    const upperDir = path.join(projectsDir, munged.toUpperCase());
    await mkdir(upperDir, { recursive: true });
    await writeFile(
      path.join(upperDir, 'sess-case.jsonl'),
      `${line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-20T10:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'Case-insensitive candidate hit' },
      })}\n`,
      'utf-8'
    );

    const result = await readSessionHistory({
      workspacePath: WORKSPACE,
      runtimeIdentity: 'sess-case',
      claudeConfigDir,
    });
    expect(result.error).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });

  describe('line classification', () => {
    it('counts all known control-line types as controlLines, not badLines', async () => {
      const lines = [
        line({ type: 'mode', uuid: 'c1', mode: 'default' }),
        line({ type: 'permission-mode', uuid: 'c2', mode: 'acceptEdits' }),
        line({ type: 'last-prompt', uuid: 'c3', prompt: 'placeholder' }),
        line({ type: 'file-history-snapshot', uuid: 'c4', snapshot: {} }),
        line({ type: 'queue-operation', uuid: 'c5', op: 'enqueue' }),
        line({ type: 'ai-title', uuid: 'c6', aiTitle: 'Sample title' }),
        line({ type: 'file-history-delta', uuid: 'c7', delta: {} }),
        line({ type: 'attribution-snapshot', uuid: 'c8', snapshot: {} }),
        line({ type: 'summary', uuid: 'c9', summary: 'placeholder summary' }),
      ];
      await writeSession(WORKSPACE, 'sess-control.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-control',
        claudeConfigDir,
      });
      expect(result.error).toBeUndefined();
      expect(result.parseStats).toEqual({ totalLines: 9, controlLines: 9, badLines: 0 });
      expect(result.messages).toEqual([]);
    });

    it('counts attachment / isMeta / isSidechain / system lines as controlLines', async () => {
      const lines = [
        line({ type: 'attachment', uuid: 'a1', attachment: { kind: 'image', path: 'x.png' } }),
        line({
          type: 'user',
          uuid: 'm1',
          isMeta: true,
          message: { role: 'user', content: '<system-reminder>housekeeping</system-reminder>' },
        }),
        line({
          type: 'assistant',
          uuid: 's1',
          isSidechain: true,
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'subagent output' }],
          },
        }),
        line({ type: 'system', subtype: 'init', uuid: 'sys1' }),
      ];
      await writeSession(WORKSPACE, 'sess-flags.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-flags',
        claudeConfigDir,
      });
      expect(result.parseStats).toEqual({ totalLines: 4, controlLines: 4, badLines: 0 });
      expect(result.messages).toEqual([]);
    });

    it('counts malformed JSON and unknown line types as badLines without crashing', async () => {
      const lines = [
        'not valid json {{{',
        line({ type: 'totally-unknown-type', uuid: 'x1' }),
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: { role: 'user', content: 'a real message survives around the bad ones' },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-bad.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-bad',
        claudeConfigDir,
      });
      expect(result.error).toBeUndefined();
      expect(result.parseStats.badLines).toBe(2);
      expect(result.messages).toHaveLength(1);
    });

    it('counts an orphan tool_result as a badLine and drops it', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'ok' }],
          },
        }),
        line({
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_nonexistent', content: 'orphan output' },
            ],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-orphan.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-orphan',
        claudeConfigDir,
      });
      expect(result.parseStats.badLines).toBe(1);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0].type).toBe('text');
    });
  });

  describe('merge and tool pairing', () => {
    it('merges consecutive assistant lines into one message', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Part 1' }],
          },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Part 2' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-merge.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-merge',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('h:a1');
      expect(result.messages[0].blocks).toHaveLength(2);
      expect(result.messages[0].blocks[0]).toMatchObject({ id: 'h:a1:0', text: 'Part 1' });
      expect(result.messages[0].blocks[1]).toMatchObject({ id: 'h:a1:1', text: 'Part 2' });
    });

    it('pairs tool_call with a matching tool_result spliced right after it', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
            ],
          },
        }),
        line({
          type: 'user',
          uuid: 'u1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [{ type: 'text', text: 'file body' }],
                is_error: false,
              },
            ],
          },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Done reading' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-pair.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-pair',
        claudeConfigDir,
      });
      // Pure tool_result lines are transparent to the merge -> everything stays one message.
      expect(result.messages).toHaveLength(1);
      const blocks = result.messages[0].blocks;
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toMatchObject({ type: 'tool_call', id: 'h:a1:0', toolCallId: 'toolu_1' });
      expect(blocks[1]).toMatchObject({
        type: 'tool_result',
        id: 'h:a1:1',
        toolCallId: 'toolu_1',
        ok: true,
        output: 'file body',
      });
      expect(blocks[2]).toMatchObject({ type: 'text', id: 'h:a1:2', text: 'Done reading' });
    });

    it('keeps a dangling tool_use with no matching tool_result as-is', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-dangling.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-dangling',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'toolu_2',
      });
    });

    it('breaks the assistant merge on a stripped-empty user line (e.g. isMeta) without emitting a message', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Message A' }],
          },
        }),
        line({
          type: 'user',
          uuid: 'meta1',
          isMeta: true,
          message: {
            role: 'user',
            content: '<system-reminder>internal housekeeping</system-reminder>',
          },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Message B' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-break-empty.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-break-empty',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toMatchObject({ id: 'h:a1' });
      expect(result.messages[1]).toMatchObject({ id: 'h:a2' });
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[1].blocks).toHaveLength(1);
    });

    it('is transparent across an isSidechain line (does not break or extend the main merge)', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Main answer part 1' }],
          },
        }),
        line({
          type: 'assistant',
          uuid: 'side1',
          isSidechain: true,
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Subagent scratch output' }],
          },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Main answer part 2' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-sidechain.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-sidechain',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('h:a1');
      expect(result.messages[0].blocks).toHaveLength(2);
      const texts = result.messages[0].blocks.map((b) => (b.type === 'text' ? b.text : null));
      expect(texts).toEqual(['Main answer part 1', 'Main answer part 2']);
      const flat = JSON.stringify(result.messages);
      expect(flat).not.toContain('Subagent scratch output');
    });

    it('splits a mixed text + tool_result user line into an injected result and a separate merge-breaking message', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'foo' } }],
          },
        }),
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:05.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_3', content: 'match found' },
              { type: 'text', text: 'Actually please also check bar' },
            ],
          },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'Checking bar now' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-mixed.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-mixed',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]).toMatchObject({ id: 'h:a1', role: 'assistant' });
      expect(result.messages[0].blocks).toHaveLength(2);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'toolu_3',
      });
      expect(result.messages[0].blocks[1]).toMatchObject({
        type: 'tool_result',
        toolCallId: 'toolu_3',
        ok: true,
        output: 'match found',
      });
      expect(result.messages[1]).toMatchObject({ id: 'h:u1', role: 'user' });
      expect(result.messages[1].blocks[0]).toMatchObject({
        type: 'text',
        text: 'Actually please also check bar',
      });
      expect(result.messages[2]).toMatchObject({ id: 'h:a2', role: 'assistant' });
    });

    it('keeps non-empty thinking blocks and drops the signature field', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [
              {
                type: 'thinking',
                thinking: 'reasoning about the fix',
                signature: 'sig-should-be-dropped',
              },
            ],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-thinking.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-thinking',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: 'thinking',
        text: 'reasoning about the fix',
      });
      expect(JSON.stringify(result.messages[0].blocks[0])).not.toContain('sig-should-be-dropped');
    });

    it('drops empty thinking blocks entirely', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [
              { type: 'thinking', thinking: '', signature: 'sig' },
              { type: 'text', text: 'final answer' },
            ],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-empty-thinking.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-empty-thinking',
        claudeConfigDir,
      });
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0].type).toBe('text');
    });
  });

  describe('truncation (§5.4)', () => {
    it('caps an assistant text block at HISTORY_BLOCK_TEXT_CAP_CHARS and flags it truncated', async () => {
      const bigText = 'A'.repeat(HISTORY_BLOCK_TEXT_CAP_CHARS + 5000);
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: bigText }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-cap-assistant.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-cap-assistant',
        claudeConfigDir,
      });
      const block = result.messages[0].blocks[0];
      expect(block.type).toBe('text');
      if (block.type === 'text') {
        expect(block.text).toHaveLength(HISTORY_BLOCK_TEXT_CAP_CHARS);
        expect(block.truncated).toBe(true);
      }
    });

    it('caps a user text block at HISTORY_USER_TEXT_CAP_CHARS and flags it truncated', async () => {
      const bigText = 'B'.repeat(HISTORY_USER_TEXT_CAP_CHARS + 6000);
      const lines = [
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: { role: 'user', content: bigText },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-cap-user.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-cap-user',
        claudeConfigDir,
      });
      const block = result.messages[0].blocks[0];
      expect(block.type).toBe('text');
      if (block.type === 'text') {
        expect(block.text).toHaveLength(HISTORY_USER_TEXT_CAP_CHARS);
        expect(block.truncated).toBe(true);
      }
    });

    it('does not set truncated on a block under the cap', async () => {
      const lines = [
        line({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'short text' }],
          },
        }),
      ];
      await writeSession(WORKSPACE, 'sess-no-cap.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-no-cap',
        claudeConfigDir,
      });
      expect(result.messages[0].blocks[0].truncated).toBeUndefined();
      expect(result.truncated).toBe(false);
    });

    it('caps the message count with a streaming ring buffer, keeping the newest and reporting omittedCount', async () => {
      const total = HISTORY_MAX_MESSAGES + 5;
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        lines.push(
          line({
            type: 'user',
            uuid: `u${i}`,
            timestamp: `2026-07-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
            message: { role: 'user', content: `User message ${i}` },
          })
        );
      }
      await writeSession(WORKSPACE, 'sess-ring.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-ring',
        claudeConfigDir,
      });
      expect(result.messages).toHaveLength(HISTORY_MAX_MESSAGES);
      expect(result.omittedCount).toBe(5);
      expect(result.truncated).toBe(true);
      expect(result.messages[0].blocks[0]).toMatchObject({ text: 'User message 5' });
      expect(result.messages[result.messages.length - 1].blocks[0]).toMatchObject({
        text: `User message ${total - 1}`,
      });
    });

    it('evicts oldest messages once the output size budget is exceeded, before hitting the count cap', async () => {
      const count = 200; // 200 * ~65KB (capped) far exceeds the 8MB budget, well under the 1000-message cap
      const filler = 'x'.repeat(70000);
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        lines.push(
          line({
            type: 'user',
            uuid: `u${i}`,
            timestamp: `2026-07-20T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
            message: { role: 'user', content: `MARK_${i}_${filler}` },
          })
        );
      }
      await writeSession(WORKSPACE, 'sess-budget.jsonl', lines);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-budget',
        claudeConfigDir,
      });
      expect(result.truncated).toBe(true);
      expect(result.omittedCount).toBeGreaterThan(0);
      expect(result.messages.length).toBeLessThan(count);

      // Oldest survivor should be a higher index than 0 (message 0 was evicted).
      const survivorMarkers = result.messages.map((m) => {
        const block = m.blocks[0];
        const text = block.type === 'text' ? block.text : '';
        const match = text.match(/^MARK_(\d+)_/);
        return match ? Number(match[1]) : -1;
      });
      expect(survivorMarkers).not.toContain(0);
      // The latest message must always survive.
      expect(survivorMarkers[survivorMarkers.length - 1]).toBe(count - 1);

      let total = 0;
      for (const m of result.messages) total += JSON.stringify(m).length;
      expect(total).toBeLessThanOrEqual(HISTORY_OUTPUT_BUDGET_CHARS);
    });

    it('tail-truncates input files larger than HISTORY_INPUT_TAIL_LIMIT_BYTES, dropping head content', async () => {
      const headMarkerLine = line({
        type: 'user',
        uuid: 'head-1',
        timestamp: '2026-07-20T09:00:00.000Z',
        message: { role: 'user', content: 'HEAD_MARKER_SHOULD_BE_DROPPED' },
      });
      // Filler control lines pad the file well past the 32MB tail threshold.
      const fillerLine = line({ type: 'summary', uuid: 'filler', summary: 'x'.repeat(1000) });
      const fillerBytesTarget = HISTORY_INPUT_TAIL_LIMIT_BYTES + 4 * 1024 * 1024; // +4MB margin
      const fillerCount = Math.ceil(fillerBytesTarget / (fillerLine.length + 1));
      const tailUserLine = line({
        type: 'user',
        uuid: 'tail-user',
        timestamp: '2026-07-20T23:59:58.000Z',
        message: { role: 'user', content: 'TAIL_USER_MARKER' },
      });
      const tailAssistantLine = line({
        type: 'assistant',
        uuid: 'tail-assistant',
        timestamp: '2026-07-20T23:59:59.000Z',
        message: {
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'TAIL_ASSISTANT_MARKER' }],
        },
      });

      const parts: string[] = [headMarkerLine];
      for (let i = 0; i < fillerCount; i++) parts.push(fillerLine);
      parts.push(tailUserLine, tailAssistantLine);

      await writeSession(WORKSPACE, 'sess-tail.jsonl', parts);

      const result = await readSessionHistory({
        workspacePath: WORKSPACE,
        runtimeIdentity: 'sess-tail',
        claudeConfigDir,
      });

      expect(result.truncated).toBe(true);
      const flat = JSON.stringify(result.messages);
      expect(flat).not.toContain('HEAD_MARKER_SHOULD_BE_DROPPED');
      expect(flat).toContain('TAIL_USER_MARKER');
      expect(flat).toContain('TAIL_ASSISTANT_MARKER');
    }, 30000);
  });
});

describe('listSessionHistory', () => {
  it('returns an empty list (not an error) when the candidate directory does not exist', async () => {
    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.error).toBeUndefined();
    expect(result.sessions).toEqual([]);
  });

  it('excludes files whose cwd does not match the requested workspace, and agent- prefixed files', async () => {
    const dir = path.join(projectsDir, mungeCwd(WORKSPACE));
    await mkdir(dir, { recursive: true });

    await writeFile(
      path.join(dir, 'sess-match.jsonl'),
      `${[
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:00.000Z',
          cwd: WORKSPACE,
          message: { role: 'user', content: 'Hello from the matching session' },
        }),
      ].join('\n')}\n`,
      'utf-8'
    );

    await writeFile(
      path.join(dir, 'sess-other.jsonl'),
      `${[
        line({
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-07-20T10:00:00.000Z',
          cwd: 'D:\\Code\\projects\\some-other-repo',
          message: { role: 'user', content: 'Hello from a different workspace' },
        }),
      ].join('\n')}\n`,
      'utf-8'
    );

    // agent- prefixed files must be excluded outright regardless of cwd.
    await writeFile(
      path.join(dir, 'agent-sess-match.jsonl'),
      `${[
        line({
          type: 'user',
          uuid: 'u3',
          timestamp: '2026-07-20T10:00:00.000Z',
          cwd: WORKSPACE,
          message: { role: 'user', content: 'Should be excluded by filename filter' },
        }),
      ].join('\n')}\n`,
      'utf-8'
    );

    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].runtimeIdentity).toBe('sess-match');
  });

  it('extracts summary fields correctly (title, firstMessage, model, createdAt, lastMessageAt)', async () => {
    const lines = [
      line({ type: 'ai-title', uuid: 'title1', aiTitle: 'Fix the login bug' }),
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-20T10:00:00.000Z',
        cwd: WORKSPACE,
        message: {
          role: 'user',
          content: '<system-reminder>context</system-reminder>Please fix the login flow bug for me',
        },
      }),
      line({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-20T10:00:05.000Z',
        cwd: WORKSPACE,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'On it.' }],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-07-20T11:30:00.000Z',
        cwd: WORKSPACE,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Fixed and tested.' }],
        },
      }),
    ];
    await writeSession(WORKSPACE, 'sess-summary.jsonl', lines);

    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(1);
    const summary = result.sessions[0];
    expect(summary.runtimeIdentity).toBe('sess-summary');
    expect(summary.title).toBe('Fix the login bug');
    expect(summary.firstMessage).toBe('Please fix the login flow bug for me');
    expect(summary.model).toBe('claude-sonnet-5');
    expect(summary.createdAt).toBe(Date.parse('2026-07-20T10:00:00.000Z'));
    expect(summary.lastMessageAt).toBe(Date.parse('2026-07-20T11:30:00.000Z'));
  });

  it('falls back to a /<command> label for firstMessage on pure-command lines', async () => {
    const lines = [
      line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-20T10:00:00.000Z',
        cwd: WORKSPACE,
        message: {
          role: 'user',
          content: '<command-message>compact</command-message><command-name>compact</command-name>',
        },
      }),
    ];
    await writeSession(WORKSPACE, 'sess-command.jsonl', lines);

    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].firstMessage).toBe('/compact');
  });

  it('sorts sessions by lastMessageAt descending', async () => {
    await writeSession(WORKSPACE, 'sess-old.jsonl', [
      line({
        type: 'user',
        uuid: 'o1',
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'Oldest session' },
      }),
    ]);
    await writeSession(WORKSPACE, 'sess-new.jsonl', [
      line({
        type: 'user',
        uuid: 'n1',
        timestamp: '2026-07-23T00:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'Newest session' },
      }),
    ]);
    await writeSession(WORKSPACE, 'sess-mid.jsonl', [
      line({
        type: 'user',
        uuid: 'm1',
        timestamp: '2026-07-10T00:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'Middle session' },
      }),
    ]);

    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.sessions.map((s) => s.runtimeIdentity)).toEqual([
      'sess-new',
      'sess-mid',
      'sess-old',
    ]);
  });

  it('aborts the whole listing with encrypted_unreadable when any file in the directory is TSD-encrypted', async () => {
    const dir = path.join(projectsDir, mungeCwd(WORKSPACE));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'sess-a.jsonl'),
      `${line({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-20T10:00:00.000Z',
        cwd: WORKSPACE,
        message: { role: 'user', content: 'normal session' },
      })}\n`,
      'utf-8'
    );
    await writeFile(path.join(dir, 'sess-b.jsonl'), `${TSD_MAGIC}\x00\x00\x00garbage`, 'utf-8');

    const result = await listSessionHistory({ workspacePath: WORKSPACE, claudeConfigDir });
    expect(result.error?.code).toBe('encrypted_unreadable');
    expect(result.sessions).toEqual([]);
  });
});
