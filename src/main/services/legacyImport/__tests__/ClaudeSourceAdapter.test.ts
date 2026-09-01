import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionScanner } from '../ClaudeSessionScanner';
import { ClaudeSourceAdapter } from '../ClaudeSourceAdapter';

let root: string;
let projectDir: string;
let sourceFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'legacy-import-adapter-'));
  projectDir = path.join(root, 'projects', 'project-a');
  await mkdir(projectDir, { recursive: true });
  sourceFile = path.join(projectDir, 'session-a.jsonl');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter(): ClaudeSourceAdapter {
  return new ClaudeSourceAdapter(
    new ClaudeSessionScanner({ resolveRoots: () => [{ dir: root, kind: 'legacy' }] })
  );
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('ClaudeSourceAdapter', () => {
  it('reads the full linear mainline, maps paired tools, and keeps unsupported entries display-only', async () => {
    const cwd = path.join(root, 'workspace');
    const source = [
      line({ type: 'system', subtype: 'init', cwd }),
      line({
        type: 'user',
        uuid: 'u1',
        cwd,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      line({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-test',
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'answer' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: 'a.ts', apiKey: 'tool-secret' },
            },
            { type: 'server_tool_use', name: 'unsupported', apiKey: 'secret-token' },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'r1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: { text: 'file contents', token: 'result-secret' },
            },
          ],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'side',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'omit me' }] },
      }),
    ].join('\n');
    await writeFile(sourceFile, `${source}\n`, 'utf8');
    const before = await stat(sourceFile);
    const beforeHash = createHash('sha256')
      .update(await readFile(sourceFile))
      .digest('hex');

    const result = await adapter().read({
      sourceKind: 'claude-code',
      projectId: 'project-a',
      sourceSessionId: 'session-a',
    });

    expect(result.conversation.workspacePath).toBe(cwd);
    expect(result.conversation.title).toBe('hello');
    expect(result.conversation.model).toBe('claude-test');
    expect(result.conversation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: 'hello', sourceEntryId: 'u1' }),
        expect.objectContaining({
          kind: 'assistant',
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: 'thinking', text: 'reasoning' }),
            expect.objectContaining({ type: 'text', text: 'answer' }),
          ]),
        }),
        expect.objectContaining({
          kind: 'display',
          displayKind: 'tool',
          toolCallId: 'tool-1',
          toolName: 'Read',
          title: 'Legacy tool call: Read',
          input: { file_path: 'a.ts', apiKey: '[redacted]' },
        }),
        expect.objectContaining({
          kind: 'display',
          displayKind: 'tool',
          toolCallId: 'tool-1',
          toolName: 'Read',
          title: 'Legacy tool result: Read',
          output: expect.stringContaining('file contents'),
        }),
        expect.objectContaining({
          kind: 'display',
          displayKind: 'custom',
          title: 'Unsupported Claude assistant block: server_tool_use',
        }),
      ])
    );
    expect(JSON.stringify(result.conversation.entries)).not.toContain('omit me');
    expect(JSON.stringify(result.conversation.entries)).not.toContain('secret-token');
    expect(JSON.stringify(result.conversation.entries)).not.toContain('tool-secret');
    expect(JSON.stringify(result.conversation.entries)).not.toContain('result-secret');
    expect(JSON.stringify(result.conversation.entries)).toContain('[redacted]');
    expect(
      result.conversation.entries.some(
        (entry) =>
          entry.kind === 'tool_result' ||
          (entry.kind === 'assistant' && entry.blocks.some((block) => block.type === 'tool_call'))
      )
    ).toBe(false);
    expect(result.conversation.diagnostics).toContain('1 sidechain line(s) omitted');

    const after = await stat(sourceFile);
    const afterHash = createHash('sha256')
      .update(await readFile(sourceFile))
      .digest('hex');
    expect({ size: after.size, mode: after.mode, mtimeMs: after.mtimeMs, hash: afterHash }).toEqual(
      {
        size: before.size,
        mode: before.mode,
        mtimeMs: before.mtimeMs,
        hash: beforeHash,
      }
    );
  });

  it('rejects a changed source before publish', async () => {
    const cwd = path.join(root, 'workspace');
    await writeFile(
      sourceFile,
      `${line({ type: 'user', uuid: 'u1', cwd, message: { content: 'hello' } })}\n${line({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'answer' }] } })}\n`,
      'utf8'
    );
    const sourceAdapter = adapter();
    const result = await sourceAdapter.read({
      sourceKind: 'claude-code',
      projectId: 'project-a',
      sourceSessionId: 'session-a',
    });
    await writeFile(sourceFile, `${await readFile(sourceFile, 'utf8')}changed\n`, 'utf8');
    await expect(
      sourceAdapter.assertUnchanged(sourceFile, result.conversation.sourceFingerprint)
    ).rejects.toThrow(/changed before publish/);
  });

  it('keeps malformed and attachment data as bounded diagnostics without dropping valid turns', async () => {
    const cwd = path.join(root, 'workspace');
    await writeFile(
      sourceFile,
      `${JSON.stringify({ type: 'system', subtype: 'init', cwd })}\nnot-json\n${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd,
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: { media_type: 'image/png', data: 'secret-bytes' } },
          ],
        },
      })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'answer' }] } })}\n`,
      'utf8'
    );
    const result = await adapter().read({
      sourceKind: 'claude-code',
      projectId: 'project-a',
      sourceSessionId: 'session-a',
    });
    expect(result.conversation.diagnostics).toContain('1 malformed JSONL line(s) skipped');
    expect(result.conversation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'display', displayKind: 'attachment' }),
      ])
    );
    expect(JSON.stringify(result.conversation)).not.toContain('secret-bytes');
  });

  it('rejects an oversized JSONL line before it can become an unbounded string', async () => {
    const cwd = path.join(root, 'workspace');
    await writeFile(
      sourceFile,
      `${JSON.stringify({ type: 'user', uuid: 'u1', cwd, message: { content: 'x'.repeat(2 * 1024 * 1024 + 1) } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [{ type: 'text', text: 'answer' }] } })}\n`,
      'utf8'
    );
    await expect(
      adapter().read({
        sourceKind: 'claude-code',
        projectId: 'project-a',
        sourceSessionId: 'session-a',
      })
    ).rejects.toThrow(/oversized JSONL line/);
  });

  it('does not expose an absolute source path through read errors', async () => {
    const scanner = new ClaudeSessionScanner({
      resolveRoots: () => [{ dir: root, kind: 'legacy' }],
    });
    const missingPath = path.join(root, 'private', 'secret-session.jsonl');
    vi.spyOn(scanner, 'resolveSessionSource').mockResolvedValue({
      projectId: 'project-a',
      sessionId: 'session-a',
      workspacePath: path.join(root, 'workspace'),
      configDir: root,
      filePath: missingPath,
      rootKind: 'legacy',
    });
    await expect(
      new ClaudeSourceAdapter(scanner).read({
        sourceKind: 'claude-code',
        projectId: 'project-a',
        sourceSessionId: 'session-a',
      })
    ).rejects.toSatisfy((error: Error) => !error.message.includes(missingPath));
  });

  it('rejects an oversized source explicitly instead of silently tailing it', async () => {
    await writeFile(sourceFile, '', 'utf8');
    await truncate(sourceFile, 64 * 1024 * 1024 + 1);
    await expect(
      adapter().read({
        sourceKind: 'claude-code',
        projectId: 'project-a',
        sourceSessionId: 'session-a',
      })
    ).rejects.toThrow(/exceeds the .* import limit/);
  });

  it('fails clearly instead of creating a user-only Pi transcript', async () => {
    const cwd = path.join(root, 'workspace');
    await writeFile(
      sourceFile,
      `${line({ type: 'user', uuid: 'u1', cwd, message: { content: 'hello' } })}\n`,
      'utf8'
    );
    await expect(
      adapter().read({
        sourceKind: 'claude-code',
        projectId: 'project-a',
        sourceSessionId: 'session-a',
      })
    ).rejects.toThrow(/no assistant response/);
  });
});
