/**
 * U05-a — isolated working directories for sessions the user never bound to a
 * project folder ("unbound" / scratch sessions).
 *
 * D02 decision 2 fixed the boundary: a chat started without picking a folder
 * still needs SOME cwd, because that is what decides where the agent's tools
 * can read and write. Handing it the user's home directory would expose
 * everything; handing it a throwaway directory keeps the default blast radius
 * to a directory that was empty a moment ago.
 *
 * ## Lifetime
 *
 * Per the batch-4 acceptance criteria a scratch directory does not survive the
 * app:
 *
 *  - allocated lazily, on the first send (or the first Pi TUI open) of an
 *    unbound session — never when the chat row is merely created, mirroring
 *    `chat:registerSession`'s "no worker before the user typed anything";
 *  - released when its session is archived (the product's "destroy a chat");
 *  - the whole root is wiped at app exit AND again at the next startup, so a
 *    crash cannot leave directories behind forever.
 *
 * The conversation itself is unaffected: Pi's JSONL lives under the agent dir,
 * not under the cwd. What a wipe drops is only files the agent wrote into the
 * scratch directory, which is what "temporary session" means — the renderer
 * marks these sessions so the user is told.
 *
 * Wiping the root wholesale is safe because the app holds a single-instance
 * lock (`app.requestSingleInstanceLock()` in `main/index.ts`), so no second
 * live instance can own directories under it.
 *
 * ## Isolation, stated honestly
 *
 * Directories are created with mode 0700, and each session gets its own. That
 * is a defence-in-depth measure, not the isolation boundary: every Pi worker
 * runs as the same OS user, so file permissions alone cannot stop worker A
 * from reading worker B's directory. The boundary that actually holds is the
 * permission layer — anything outside a session's own cwd is an
 * `external_directory` access, which the delegation envelope caps at `defer`
 * (a prompt) no matter what tier the session is on. `isScratchPath` exists so
 * Main can recognise these directories and start the session untrusted.
 *
 * On Windows `mode` is ignored by the OS; the permission-layer argument above
 * is what carries there.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getEffectiveTemporaryBasePath } from '@shared/defaultPaths';
import { canonicalPathKey } from '@shared/utils/path';
import { readSharedSettings } from '../SharedSessionState';

/**
 * Directory under the user's temporary base that holds every scratch cwd.
 *
 * Deliberately NOT a direct sibling of the user-managed temp workspaces: those
 * are listed and removed by `temp:workspace:*`, which only accepts direct
 * children of the base, so nesting ours one level down keeps the two features
 * from deleting each other's directories.
 */
export const SCRATCH_ROOT_DIR = 'unbound-sessions';

/** Settings key the renderer writes for the temp-session base path. */
const TEMPORARY_PATH_SETTING_KEY = 'defaultTemporaryPath';

export interface ScratchWorkspaceServiceOptions {
  /** Injected in tests; production reads the user's setting. */
  resolveBasePath?: () => string;
  createId?: () => string;
  log?: (...args: unknown[]) => void;
}

function settingsTemporaryPath(): string {
  const configured = readSharedSettings()[TEMPORARY_PATH_SETTING_KEY];
  return typeof configured === 'string' ? configured : '';
}

/**
 * The base the user can change in Settings → General ("temp session path"),
 * falling back to the same default the existing temp-workspace feature uses.
 */
function productionBasePath(): string {
  return getEffectiveTemporaryBasePath(settingsTemporaryPath(), homedir(), path.sep);
}

export class ScratchWorkspaceService {
  private readonly resolveBasePath: () => string;
  private readonly createId: () => string;
  private readonly log: (...args: unknown[]) => void;
  private readonly pathsBySession = new Map<string, string>();
  /** Serializes allocate/release/wipe so a concurrent first send cannot race. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ScratchWorkspaceServiceOptions = {}) {
    this.resolveBasePath = options.resolveBasePath ?? productionBasePath;
    this.createId = options.createId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
  }

  /** Absolute path of the directory that holds every scratch cwd. */
  rootPath(): string {
    return path.join(this.resolveBasePath(), SCRATCH_ROOT_DIR);
  }

  /** The directory already allocated for this session, or null. */
  pathFor(sessionId: string): string | null {
    return this.pathsBySession.get(sessionId) ?? null;
  }

  /**
   * Is this path one of ours?
   *
   * Answered by prefix, not by the in-memory map: after an app restart a
   * session-index row still carries last run's scratch path, and Main must
   * still recognise it as untrusted rather than treating it as a real project.
   */
  isScratchPath(candidate: string): boolean {
    if (!candidate.trim()) return false;
    // `canonicalPathKey` already folds separators to `/` and trims trailing
    // ones, so a plain prefix test is exact here — no `path.relative` on
    // half-normalized strings.
    return canonicalPathKey(candidate).startsWith(`${canonicalPathKey(this.rootPath())}/`);
  }

  /**
   * Allocate (or return) this session's isolated cwd.
   *
   * Idempotent per session: the send path and the TUI path both call it, and a
   * session must never end up with two different working directories.
   */
  ensure(sessionId: string): Promise<string> {
    if (!sessionId.trim()) {
      return Promise.reject(new Error('scratch_workspace_invalid_session'));
    }
    return this.serialize(async () => {
      const existing = this.pathsBySession.get(sessionId);
      if (existing) {
        // Recreate rather than trust the map: an external wipe of the temp base
        // between two turns would otherwise hand Pi a cwd that no longer exists.
        await mkdir(existing, { recursive: true, mode: 0o700 });
        return existing;
      }
      const target = path.join(this.rootPath(), this.createId());
      await mkdir(target, { recursive: true, mode: 0o700 });
      this.pathsBySession.set(sessionId, target);
      return target;
    });
  }

  /**
   * Re-take ownership of a scratch path recorded in a previous app run.
   *
   * The startup wipe deletes last run's directories, but the session-index row
   * of an unbound chat still names one. Resuming that chat must not hand Pi a
   * cwd that no longer exists, and re-allocating a fresh path would make the
   * indexed row wrong — so the directory is recreated at its recorded path,
   * empty. The conversation survives (Pi's JSONL lives under the agent dir);
   * files the agent had written there do not, which is what makes the session
   * temporary.
   *
   * Rejects a path outside the scratch root so a tampered index row cannot
   * turn this into "create and later delete an arbitrary directory".
   */
  adopt(sessionId: string, existingPath: string): Promise<string> {
    if (!this.isScratchPath(existingPath)) {
      return Promise.reject(new Error('scratch_workspace_foreign_path'));
    }
    return this.serialize(async () => {
      await mkdir(existingPath, { recursive: true, mode: 0o700 });
      this.pathsBySession.set(sessionId, existingPath);
      return existingPath;
    });
  }

  /** Drop one session's directory — the "session destroyed" cleanup path. */
  release(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      const target = this.pathsBySession.get(sessionId);
      if (!target) return;
      this.pathsBySession.delete(sessionId);
      await this.removeQuietly(target);
    });
  }

  /**
   * Remove the whole scratch root — the app-exit and app-startup cleanup path.
   *
   * Startup and shutdown share one implementation on purpose: the startup call
   * is exactly the shutdown that a crash never got to run.
   */
  wipeAll(): Promise<void> {
    return this.serialize(async () => {
      this.pathsBySession.clear();
      await this.removeQuietly(this.rootPath());
    });
  }

  private async removeQuietly(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      // Cleanup is best-effort by design: a locked file on Windows must not
      // fail an app quit or an archive. The next startup wipe retries it.
      this.log('[scratch] failed to remove', target, error);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export const scratchWorkspaceService = new ScratchWorkspaceService();
