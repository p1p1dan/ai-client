import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_SDK_STUB_SUFFIX } from '../../shared/claudeSdkEngine.ts';
import { createStub, readStub, stubPathFor, writeStub } from '../sessionStub.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccsdk-stub-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session stub: model (S-1 contract)', () => {
  it('records the bootstrap model at create, under the shared suffix', () => {
    const configDir = tempDir();
    const { file, stub } = createStub(configDir, 'chat-1', 'D:\\work', 'gw/claude-opus-5-5');
    expect(file.endsWith(CLAUDE_SDK_STUB_SUFFIX)).toBe(true);
    expect(file).toBe(stubPathFor(configDir, stub.ccSessionId));
    expect(JSON.parse(readFileSync(file, 'utf8')).model).toBe('gw/claude-opus-5-5');
    expect(readStub(file).model).toBe('gw/claude-opus-5-5');
  });

  it('writes no model when the bootstrap named none', () => {
    const { file } = createStub(tempDir(), 'chat-2', '/work');
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('model');
    expect(readStub(file)).not.toHaveProperty('model');
  });

  it('keeps an updated model across a rewrite', () => {
    const { file, stub } = createStub(tempDir(), 'chat-3', '/work', 'gw/claude-opus-5-5');
    writeStub(file, { ...stub, started: true, model: 'gw/claude-sonnet-5' });
    expect(readStub(file)).toMatchObject({ started: true, model: 'gw/claude-sonnet-5' });
  });

  it('still reads a stub written before S-1 (no model)', () => {
    const dir = tempDir();
    const file = join(dir, `0b5c3c1e-0000-4000-8000-000000000000${CLAUDE_SDK_STUB_SUFFIX}`);
    writeFileSync(
      file,
      JSON.stringify({
        engine: 'claude-sdk',
        version: 1,
        ccSessionId: '0b5c3c1e-0000-4000-8000-000000000000',
        logicalSessionId: 'chat-old',
        cwd: '/work',
        createdAt: 1_790_000_000_000,
        started: true,
      })
    );
    const stub = readStub(file);
    expect(stub).toMatchObject({ logicalSessionId: 'chat-old', started: true });
    expect(stub.model).toBeUndefined();
  });

  it('ignores a model that is not a non-empty string', () => {
    const { file, stub } = createStub(tempDir(), 'chat-4', '/work');
    writeFileSync(file, JSON.stringify({ ...stub, model: 42 }));
    expect(readStub(file).model).toBeUndefined();
    writeFileSync(file, JSON.stringify({ ...stub, model: '' }));
    expect(readStub(file).model).toBeUndefined();
  });
});
