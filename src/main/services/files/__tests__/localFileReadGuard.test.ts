import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isAllowedLocalFileReadPath,
  registerAllowedLocalFileRoot,
  resolveAllowedLocalFileReadPath,
  unregisterAllowedLocalFileRootsByOwner,
} from '../LocalFileAccess';

const OWNER = 'read-guard-test';
const roots: string[] = [];

afterEach(() => {
  unregisterAllowedLocalFileRootsByOwner(OWNER);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'aiclient-local-read-'));
  roots.push(base);
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  const insideFile = path.join(workspace, 'inside.png');
  const outsideFile = path.join(outside, 'secret.png');
  writeFileSync(insideFile, 'inside');
  writeFileSync(outsideFile, 'outside');
  registerAllowedLocalFileRoot(workspace, OWNER);
  return { workspace, insideFile, outsideFile };
}

describe('isAllowedLocalFileReadPath', () => {
  it('allows a real file physically contained by the workspace', () => {
    const { insideFile } = fixture();
    expect(isAllowedLocalFileReadPath(insideFile)).toBe(true);
    expect(resolveAllowedLocalFileReadPath(insideFile)).toBe(insideFile);
  });

  it('rejects a lexical child whose symlink target escapes the workspace', () => {
    const { workspace, outsideFile } = fixture();
    const linked = path.join(workspace, 'linked.png');
    symlinkSync(outsideFile, linked);
    expect(isAllowedLocalFileReadPath(linked)).toBe(false);
  });

  it('allows a symlink only when its physical target stays inside the workspace', () => {
    const { workspace, insideFile } = fixture();
    const linked = path.join(workspace, 'linked-inside.png');
    symlinkSync(insideFile, linked);
    expect(isAllowedLocalFileReadPath(linked)).toBe(true);
  });

  it('rejects missing files and paths outside every registered root', () => {
    const { workspace, outsideFile } = fixture();
    expect(isAllowedLocalFileReadPath(path.join(workspace, 'missing.png'))).toBe(false);
    expect(isAllowedLocalFileReadPath(outsideFile)).toBe(false);
  });
});
