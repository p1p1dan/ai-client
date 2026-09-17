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
  app: { on: vi.fn(), getPath: vi.fn(() => tmpdir()) },
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
// Stubbed one level BELOW `ipc/settings`, so the real unwrap of the renderer's
// persist wrapper runs here too. Stubbing `readSettings` itself let this file
// hand the service a flat `{ defaultTemporaryPath }` object that no settings.json
// has ever had, which is what kept D13 invisible to the suite.
vi.mock('../../services/SharedSessionState', () => ({
  readSharedSettings: () => settings.value,
  writeSharedSettings: vi.fn(),
  writeSharedSettingsToSession: vi.fn(),
}));

import {
  adoptTempWorkspace,
  isTempWorkspacePath,
} from '../../services/agent-host/TempWorkspaceService';
import { registerTempWorkspaceHandlers } from '../tempWorkspace';

registerTempWorkspaceHandlers();
const remove = handlers.get(IPC_CHANNELS.TEMP_WORKSPACE_REMOVE) as RemoveHandler;

/**
 * Put a saved location on disk the way settings.json really holds it: nested
 * under the renderer's zustand persist key, never on the file's top level.
 */
function savedLocation(defaultTemporaryPath: string): void {
  settings.value = { 'aiclient-settings': { state: { defaultTemporaryPath }, version: 0 } };
}

async function withBase(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'temp-ws-recovery-'));
  savedLocation(base);
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

  /**
   * main-aux-07 — the saved location is a free-text field, and the setting was
   * compared as the raw string the user typed while the candidate went through
   * `path.resolve`. A trailing separator (or any other un-normalised form) made
   * the comparison always false, which silently switched the whole self-heal
   * below off.
   */
  describe('with a base path the user did not type in normalised form', () => {
    it('accepts a direct child when the saved location ends with a separator', async () => {
      await withBase(async (base) => {
        savedLocation(`${base}${path.sep}`);
        expect(isTempWorkspacePath(path.join(base, '20260819-153654'))).toBe(true);
      });
    });

    it('accepts a direct child when the saved location still contains a .. segment', async () => {
      await withBase(async (base) => {
        savedLocation(`${base}${path.sep}sub${path.sep}..`);
        expect(isTempWorkspacePath(path.join(base, '20260819-153654'))).toBe(true);
      });
    });

    it('still rejects the base itself and a nested grandchild', async () => {
      await withBase(async (base) => {
        savedLocation(`${base}${path.sep}`);
        expect(isTempWorkspacePath(base)).toBe(false);
        expect(isTempWorkspacePath(`${base}${path.sep}`)).toBe(false);
        expect(isTempWorkspacePath(path.join(base, 'a', 'b'))).toBe(false);
      });
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

  it('still heals a workspace when the saved location ends with a separator', async () => {
    // main-aux-07: the guard said "not mine", `adoptTempWorkspace` returned
    // early, and the chat then failed to spawn on a cwd that was never put back.
    await withBase(async (base) => {
      savedLocation(`${base}${path.sep}`);
      const recorded = path.join(base, '20260819-153654');

      await adoptTempWorkspace(recorded);

      expect(existsSync(recorded)).toBe(true);
      expect(gitInit).toHaveBeenCalledTimes(1);
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
