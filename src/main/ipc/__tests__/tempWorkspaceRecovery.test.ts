/**
 * F2 (Windows test.11 GUI acceptance): a temp workspace whose directory the
 * user deleted by hand left its session unusable in two separate ways — the
 * chat could not spawn (`spawn ...node.exe ENOENT`, actually a missing cwd) and
 * the stale row could not be deleted. Both paths are covered here.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS, type TempWorkspaceRemoveResult } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type RemoveHandler = (
  event: unknown,
  dirPath: string,
  base?: string
) => Promise<TempWorkspaceRemoveResult>;

const { handlers, gitInit, settings } = vi.hoisted(() => ({
  handlers: new Map<string, RemoveHandler>(),
  gitInit: vi.fn(async () => undefined),
  settings: { value: {} as Record<string, unknown> },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: RemoveHandler) => handlers.set(name, handler) },
}));
vi.mock('../../services/git/GitService', () => ({
  GitService: class {
    init = gitInit;
  },
}));
vi.mock('../../services/session/SessionManager', () => ({
  sessionManager: { killByWorkdir: vi.fn(async () => undefined) },
}));
vi.mock('../files', () => ({ stopWatchersInDirectory: vi.fn(async () => undefined) }));
vi.mock('../git', () => ({ unregisterAuthorizedWorkdir: vi.fn() }));
vi.mock('../settings', () => ({ readSettings: () => settings.value }));

import {
  adoptTempWorkspace,
  isTempWorkspacePath,
} from '../../services/agent-host/TempWorkspaceService';
import { registerTempWorkspaceHandlers } from '../tempWorkspace';

registerTempWorkspaceHandlers();
const remove = handlers.get(IPC_CHANNELS.TEMP_WORKSPACE_REMOVE) as RemoveHandler;

async function withBase(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'temp-ws-recovery-'));
  settings.value = { defaultTemporaryPath: base };
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

beforeEach(() => {
  gitInit.mockClear();
});

describe('TEMP_WORKSPACE_REMOVE with a directory that is already gone', () => {
  it('reports success instead of failing the symlink guard on ENOENT', async () => {
    // The whole point of the call is "make this not exist"; it already does not.
    // Before the fix, `lstat` threw ENOENT here and the user was left unable to
    // clear a row for a folder they had deleted themselves.
    await withBase(async (base) => {
      const missing = path.join(base, '20260819-153654');

      const result = await remove({}, missing, base);

      expect(result.ok).toBe(true);
    });
  });

  it('still removes a directory that does exist', async () => {
    await withBase(async (base) => {
      const target = path.join(base, '20260908-181300');
      await mkdir(target);

      const result = await remove({}, target, base);

      expect(result.ok).toBe(true);
      expect(existsSync(target)).toBe(false);
    });
  });

  it('still refuses a symlink that exists', async () => {
    await withBase(async (base) => {
      const real = await mkdtemp(path.join(tmpdir(), 'temp-ws-target-'));
      const link = path.join(base, 'linked');
      await symlink(real, link, 'dir');
      try {
        const result = await remove({}, link, base);

        expect(result).toMatchObject({ ok: false, code: 'INVALID_PATH' });
        expect(existsSync(real)).toBe(true);
      } finally {
        await rm(real, { recursive: true, force: true });
      }
    });
  });
});

describe('isTempWorkspacePath', () => {
  it('accepts a direct child of the configured base', async () => {
    await withBase(async (base) => {
      expect(isTempWorkspacePath(path.join(base, '20260819-153654'))).toBe(true);
    });
  });

  it('rejects a nested grandchild', async () => {
    // The create handler only ever makes direct children, so anything deeper is
    // not a temp workspace and must not be recreatable through this path.
    await withBase(async (base) => {
      expect(isTempWorkspacePath(path.join(base, 'a', 'b'))).toBe(false);
    });
  });

  it('rejects the base itself and anything outside it', async () => {
    await withBase(async (base) => {
      expect(isTempWorkspacePath(base)).toBe(false);
      expect(isTempWorkspacePath(path.join(tmpdir(), 'somewhere-else'))).toBe(false);
    });
  });
});

describe('adoptTempWorkspace', () => {
  it('recreates a deleted temp workspace at its recorded path, repo and all', async () => {
    await withBase(async (base) => {
      const recorded = path.join(base, '20260819-153654');

      await adoptTempWorkspace(recorded);

      expect(existsSync(recorded)).toBe(true);
      // A bare mkdir would leave a directory that is not equivalent to a freshly
      // created temp workspace — the create handler runs `git init` too.
      expect(gitInit).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves an existing workspace with a repo untouched', async () => {
    await withBase(async (base) => {
      const existing = path.join(base, '20260908-181300');
      await mkdir(path.join(existing, '.git'), { recursive: true });

      await adoptTempWorkspace(existing);

      expect(gitInit).not.toHaveBeenCalled();
    });
  });

  it('refuses to create anything outside the temp base', async () => {
    // A tampered index row must not turn resume into "create an arbitrary
    // directory" — the same guard `ScratchWorkspaceService.adopt` applies.
    await withBase(async () => {
      const foreign = path.join(tmpdir(), `not-a-temp-workspace-${process.pid}`);

      await adoptTempWorkspace(foreign);

      expect(existsSync(foreign)).toBe(false);
      expect(gitInit).not.toHaveBeenCalled();
    });
  });
});
