import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS, type TempWorkspaceCreateResult } from '@shared/types';
import { expect, it, vi } from 'vitest';

type CreateHandler = (event: unknown, base?: string) => Promise<TempWorkspaceCreateResult>;
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, CreateHandler>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: CreateHandler) => handlers.set(name, handler) },
}));
vi.mock('../../services/git/GitService', () => ({
  GitService: class {
    init = async () => undefined;
  },
}));
vi.mock('../../services/session/SessionManager', () => ({ sessionManager: {} }));
vi.mock('../files', () => ({ stopWatchersInDirectory: vi.fn() }));
vi.mock('../git', () => ({ unregisterAuthorizedWorkdir: vi.fn() }));

import { registerTempWorkspaceHandlers } from '../tempWorkspace';

it('creates with the actual clock, preserves old folders and avoids same-second reuse', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gui-temp-create-'));
  const old = path.join(base, '20260506-104237');
  await mkdir(old);
  await writeFile(path.join(old, 'keep.txt'), 'user content');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 8, 18, 13, 0));
  try {
    registerTempWorkspaceHandlers();
    const create = handlers.get(IPC_CHANNELS.TEMP_WORKSPACE_CREATE)!;
    const first: TempWorkspaceCreateResult = await create({}, base);
    const second: TempWorkspaceCreateResult = await create({}, base);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('creation failed');
    expect(first.item.folderName).toBe('20260908-181300');
    expect(first.item.createdAt).toBe(Date.now());
    expect(second.item.path).not.toBe(first.item.path);
    expect(await readFile(path.join(old, 'keep.txt'), 'utf8')).toBe('user content');
  } finally {
    vi.useRealTimers();
    await rm(base, { recursive: true, force: true });
  }
});
