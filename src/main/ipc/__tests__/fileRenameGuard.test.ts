/**
 * T095: `file:rename` must refuse a relative destination.
 *
 * The renderer used to hand this channel the BARE new file name from the
 * tree's inline editor. `rename()` resolves that against the MAIN PROCESS cwd,
 * so the outcome depended on where the app happened to be launched: with the
 * workspace as cwd the file was silently moved to the repository root, and
 * otherwise the workspace guard rejected a path the user never typed. The
 * renderer-side join is the fix; this is the boundary check that keeps any
 * future caller from re-introducing it.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILE_CONTENT_CONFLICT, IPC_CHANNELS } from '@shared/types';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null, fromId: () => null },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  shell: { showItemInFolder: () => undefined },
}));

// The real class loads a native addon through `createRequire`, which module
// mocking cannot intercept; nothing in this file starts a watcher anyway.
vi.mock('../../services/files/FileWatcher', () => ({
  FileWatcher: class {
    start = async () => undefined;
    stop = async () => undefined;
  },
}));

import { registerAllowedLocalFileRoot } from '../../services/files/LocalFileAccess';
import { registerFileHandlers } from '../files';

let workspace: string;

beforeAll(async () => {
  registerFileHandlers();
  workspace = await mkdtemp(path.join(tmpdir(), 'rename-guard-'));
  // What `file:list` does for a real workspace, so the write guard is not the
  // thing under test here.
  registerAllowedLocalFileRoot(workspace);
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

it('refuses a bare file name as the rename destination and leaves the file alone', async () => {
  const rename = handlers.get(IPC_CHANNELS.FILE_RENAME) as Handler;
  const source = path.join(workspace, 'original.ts');
  await writeFile(source, 'export {};');

  await expect(rename({}, source, 'renamed.ts')).rejects.toThrow(/must be absolute/);
  await expect(rename({}, 'original.ts', path.join(workspace, 'renamed.ts'))).rejects.toThrow(
    /must be absolute/
  );

  expect(await readdir(workspace)).toEqual(['original.ts']);
});

it('renames when both ends are absolute paths inside the workspace', async () => {
  const rename = handlers.get(IPC_CHANNELS.FILE_RENAME) as Handler;
  const source = path.join(workspace, 'original.ts');
  const target = path.join(workspace, 'renamed.ts');

  await rename({}, source, target);

  expect(await readdir(workspace)).toEqual(['renamed.ts']);
});

it('refuses to overwrite an external A-to-B edit with a stale baseline', async () => {
  const write = handlers.get(IPC_CHANNELS.FILE_WRITE) as Handler;
  const target = path.join(workspace, 'external-edit.ts');
  await writeFile(target, 'A', 'utf8');
  await writeFile(target, 'B', 'utf8');

  await expect(write({}, target, 'C', 'utf-8', 'A')).rejects.toThrow(FILE_CONTENT_CONFLICT);
  expect(await readFile(target, 'utf8')).toBe('B');
});

it('allows a matching baseline and rejects the next stale writer', async () => {
  const write = handlers.get(IPC_CHANNELS.FILE_WRITE) as Handler;
  const target = path.join(workspace, 'cross-window.ts');
  await writeFile(target, 'A', 'utf8');

  await write({}, target, 'C', 'utf-8', 'A');
  await expect(write({}, target, 'D', 'utf-8', 'A')).rejects.toThrow(FILE_CONTENT_CONFLICT);
  expect(await readFile(target, 'utf8')).toBe('C');
});
