import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSessionScanner } from '../ClaudeSessionScanner';

describe('ClaudeSessionScanner', () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-scanner-'));
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    await fs.mkdir(path.join(tempDir, 'projects'), { recursive: true });
  });

  afterEach(async () => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('prefers cwd from jsonl entries over directory name fallback', async () => {
    const projectId = 'D--Projects-jyw-ai-jyw-ai-client';
    const projectDir = path.join(tempDir, 'projects', projectId);
    await fs.mkdir(projectDir, { recursive: true });

    const sessionId = '5654315f-e717-4a41-b7ad-f9ac5d7b9f04';
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);

    const cwd = 'D:\\Projects\\jyw_ai\\jyw-ai-client';
    const jsonl = [
      JSON.stringify({ type: 'file-history-snapshot', isSnapshotUpdate: true }),
      JSON.stringify({
        type: 'user',
        cwd,
        timestamp: '2026-04-09T08:32:28.907Z',
        message: { role: 'user', content: '你好，世界' },
      }),
    ].join('\n');
    await fs.writeFile(filePath, `${jsonl}\n`, 'utf-8');

    const scanner = new ClaudeSessionScanner();
    const projects = await scanner.scanProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(projectId);
    expect(projects[0]?.path).toBe(cwd);
  });

  it('extracts firstMessage when message.content is a string', async () => {
    const projectId = 'D--Projects-jyw-ai-jyw-ai-client';
    const projectDir = path.join(tempDir, 'projects', projectId);
    await fs.mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, 'session-1.jsonl');
    const jsonl = [
      JSON.stringify({
        type: 'user',
        cwd: 'D:\\Projects\\jyw_ai\\jyw-ai-client',
        timestamp: '2026-04-09T08:32:28.907Z',
        message: { role: 'user', content: '第一行\n第二行' },
      }),
    ].join('\n');
    await fs.writeFile(filePath, `${jsonl}\n`, 'utf-8');

    const scanner = new ClaudeSessionScanner();
    const sessions = await scanner.getSessionsForProject(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.firstMessage).toBe('第一行 第二行');
  });

  it('extracts firstMessage when message.content is an array of blocks', async () => {
    const projectId = 'D--Projects-jyw-ai-jyw-ai-client';
    const projectDir = path.join(tempDir, 'projects', projectId);
    await fs.mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, 'session-2.jsonl');
    const jsonl = [
      JSON.stringify({
        type: 'user',
        cwd: 'D:\\Projects\\jyw_ai\\jyw-ai-client',
        timestamp: '2026-04-09T08:32:28.907Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
            { type: 'tool_result', content: 'ignored' },
          ],
        },
      }),
    ].join('\n');
    await fs.writeFile(filePath, `${jsonl}\n`, 'utf-8');

    const scanner = new ClaudeSessionScanner();
    const sessions = await scanner.getSessionsForProject(projectId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.firstMessage).toBe('Hello World');
  });
});

