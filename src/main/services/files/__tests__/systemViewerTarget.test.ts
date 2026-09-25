import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveSystemViewerTarget } from '../systemViewerTarget';

describe('resolveSystemViewerTarget (T5 "Open with system viewer")', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'system-viewer-'));
    writeFileSync(path.join(dir, 'shot.png'), 'png');
    writeFileSync(path.join(dir, 'Doc.PDF'), 'pdf');
    writeFileSync(path.join(dir, 'tool.sh'), '#!/bin/sh\n');
    mkdirSync(path.join(dir, 'folder.png'));
    symlinkSync(path.join(dir, 'tool.sh'), path.join(dir, 'disguised.png'));
    symlinkSync(path.join(dir, 'shot.png'), path.join(dir, 'alias.jpg'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens an existing image or PDF, outside any workspace', async () => {
    expect(await resolveSystemViewerTarget(path.join(dir, 'shot.png'))).toBe(
      path.join(dir, 'shot.png')
    );
    expect(await resolveSystemViewerTarget(path.join(dir, 'Doc.PDF'))).toBe(
      path.join(dir, 'Doc.PDF')
    );
  });

  it('follows a symlink only when its target is previewable too', async () => {
    expect(await resolveSystemViewerTarget(path.join(dir, 'alias.jpg'))).toBe(
      path.join(dir, 'shot.png')
    );
    expect(await resolveSystemViewerTarget(path.join(dir, 'disguised.png'))).toBeNull();
  });

  it.each([
    ['a missing file', () => path.join(dir, 'missing.png')],
    ['a directory with an image name', () => path.join(dir, 'folder.png')],
    ['a non-preview extension', () => path.join(dir, 'tool.sh')],
    ['a relative path', () => 'shot.png'],
    ['a remote virtual path', () => '/__aiclient_remote__/conn/home/u/x.png'],
    ['an embedded NUL', () => `${path.join(dir, 'shot.png')}\0.exe`],
    ['an empty string', () => ''],
  ])('refuses %s', async (_label, target) => {
    expect(await resolveSystemViewerTarget(target())).toBeNull();
  });

  it('refuses non-string input without touching the filesystem', async () => {
    const deps = { realpath: vi.fn(), stat: vi.fn() };
    for (const value of [undefined, null, 42, { path: '/x.png' }, ['/x.png']]) {
      expect(await resolveSystemViewerTarget(value, deps)).toBeNull();
    }
    expect(deps.realpath).not.toHaveBeenCalled();
    expect(deps.stat).not.toHaveBeenCalled();
  });
});
