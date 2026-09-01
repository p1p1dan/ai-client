import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPiSessionFileIdentity, preflightPiSessionFile } from '../piSessionPreflight.ts';

const dirs: string[] = [];

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiclient-pi-history-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  await writeFile(file, content, 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Pi session exact-file preflight', () => {
  it('reads a valid leading-blank header without modifying the source', async () => {
    const content = `\n{"type":"session","id":"pi-1","cwd":"/repo"}\n{"type":"message","id":"u1"}\n`;
    const file = await tempFile(content);

    const metadata = await preflightPiSessionFile(file, '/repo');
    expect(metadata).toMatchObject({ sessionId: 'pi-1', cwd: '/repo' });
    expect(typeof metadata.fileIdentity.dev).toBe('bigint');
    expect(typeof metadata.fileIdentity.ino).toBe('bigint');
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('accepts a valid single-record JSONL file without a trailing newline', async () => {
    const file = await tempFile('{"type":"session","id":"pi-one-line","cwd":"/repo"}');
    await expect(preflightPiSessionFile(file, '/repo')).resolves.toMatchObject({
      sessionId: 'pi-one-line',
      cwd: '/repo',
    });
  });

  it('detects a pathname replacement between preflight and SDK open', async () => {
    const file = await tempFile('{"type":"session","id":"pi-old","cwd":"/repo"}\n');
    const metadata = await preflightPiSessionFile(file, '/repo');
    await rename(file, `${file}.old`);
    await writeFile(file, '{"type":"session","id":"pi-new","cwd":"/repo"}\n', 'utf8');
    await expect(assertPiSessionFileIdentity(file, metadata.fileIdentity)).rejects.toMatchObject({
      code: 'WORKER_SESSION_IDENTITY_MISMATCH',
    });
  });

  it('classifies missing, corrupt, and cross-cwd files without creating replacements', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiclient-pi-history-'));
    dirs.push(dir);
    const missing = join(dir, 'missing.jsonl');
    await expect(preflightPiSessionFile(missing, '/repo')).rejects.toMatchObject({
      code: 'WORKER_SESSION_FILE_NOT_FOUND',
    });
    await expect(readFile(missing, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const corrupt = await tempFile('{not json}\n');
    await expect(preflightPiSessionFile(corrupt, '/repo')).rejects.toMatchObject({
      code: 'WORKER_SESSION_FILE_CORRUPT',
    });

    const other = await tempFile('{"type":"session","id":"pi-2","cwd":"/other"}\n');
    await expect(preflightPiSessionFile(other, '/repo')).rejects.toMatchObject({
      code: 'WORKER_SESSION_CWD_MISMATCH',
      message: expect.stringContaining('file declares /other'),
    });
  });
});
