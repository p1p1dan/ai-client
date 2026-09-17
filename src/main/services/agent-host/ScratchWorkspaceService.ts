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
import { redactStderrLine, sanitizeStderrLine } from '../../../agent-host/stderrRedaction';
import { readStringSetting, TEMPORARY_PATH_SETTING_KEY } from '../../ipc/settings';
import { isInsideDirectory, resolveWorkspacePath } from './workspaceContainment';

/**
 * Directory under the user's temporary base that holds every scratch cwd.
 *
 * Deliberately NOT a direct sibling of the user-managed temp workspaces: those
 * are listed and removed by `temp:workspace:*`, which only accepts direct
 * children of the base, so nesting ours one level down keeps the two features
 * from deleting each other's directories.
 */
export const SCRATCH_ROOT_DIR = 'unbound-sessions';

/** An error as one loggable sentence, so the redactor sees all of it. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message ? `${error.name}: ${error.message}` : error.name;
}

export interface ScratchWorkspaceServiceOptions {
  /** Injected in tests; production reads the user's setting. */
  resolveBasePath?: () => string;
  createId?: () => string;
  /**
   * Milestone sink (info level). Defaults to the hijacked `console.log`, which
   * IS electron-log in the main process — T066 (D14): this used to default to
   * a no-op and production never passed one, so the service's only existing
   * line (`failed to remove`) could not reach a log file even in principle.
   * Tests inject their own to assert on it.
   */
  log?: (...args: unknown[]) => void;
}

function settingsTemporaryPath(): string {
  // F2-a: read the same copy `TempWorkspaceService` does. `readSharedSettings`
  // only sees what has been flushed to disk, so a base path the user just
  // changed in Settings sent scratch directories to the OLD root while temp
  // workspaces already used the new one — two directory kinds disagreeing about
  // one setting is exactly what the field pass reported as "实际的临时工作区跟
  // 设置里的不一样".
  //
  // D13: reading the same copy was necessary but not sufficient. Both readers
  // took the key off the settings FILE's top level, where no user-facing
  // setting has ever lived — it is nested under the renderer's persist wrapper
  // — so both read `undefined` and both fell back to the default root, which is
  // why F2-a's promise was not observable on a real machine. The unwrap now
  // lives in `readStringSetting`, once, for every Main-side reader.
  return readStringSetting(TEMPORARY_PATH_SETTING_KEY);
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
  /**
   * Every root this process has resolved from the setting, newest included.
   *
   * F2-a made both readers see a base-path change immediately, which also means
   * a change moves `rootPath()` out from under directories already allocated
   * under the old one. Those are still ours: still to be recognised as scratch
   * (that is what starts the session without project trust) and still to be
   * wiped at exit. Only roots computed from the setting go in here — never a
   * root derived from a path an index row or an import file handed us, which is
   * what keeps `wipeAll` from being aimed at an arbitrary directory.
   */
  private readonly knownRoots = new Set<string>();
  /** Serializes allocate/release/wipe so a concurrent first send cannot race. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: ScratchWorkspaceServiceOptions = {}) {
    this.resolveBasePath = options.resolveBasePath ?? productionBasePath;
    this.createId = options.createId ?? randomUUID;
    this.log = options.log ?? ((...args: unknown[]) => console.log(...args));
  }

  /** Absolute path of the directory that holds every scratch cwd. */
  rootPath(): string {
    const root = resolveWorkspacePath(path.join(this.resolveBasePath(), SCRATCH_ROOT_DIR));
    this.knownRoots.add(root);
    return root;
  }

  /** The directory already allocated for this session, or null. */
  pathFor(sessionId: string): string | null {
    return this.pathsBySession.get(sessionId) ?? null;
  }

  /**
   * Is this path one of ours?
   *
   * Answered by containment, not by the in-memory map: after an app restart a
   * session-index row still carries last run's scratch path, and Main must
   * still recognise it as untrusted rather than treating it as a real project.
   *
   * Containment is decided by `path.resolve` + `path.relative`, never by a
   * string prefix. The prefix form accepted `<root>/../<anything>`, because the
   * comparison key it used folds separators but does not resolve `..` — and
   * this is the only check `adopt` has, so an index row in that shape used to
   * make Main create, own and (on archive) recursively delete a directory
   * outside the root (main-aux-01).
   */
  isScratchPath(candidate: string): boolean {
    if (!candidate.trim()) return false;
    const roots = [this.rootPath(), ...this.knownRoots];
    return roots.some((root) => isInsideDirectory(root, candidate));
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

  /**
   * Drop one session's directory — the "session destroyed" cleanup path.
   *
   * T066 (D14): the outcome is logged because the two ways this can end are
   * indistinguishable from outside — the directory is deleted, or it is kept
   * because another session still runs in the same one — and neither used to
   * say anything. The path is redacted (T042) before it is written down.
   */
  release(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      const target = this.pathsBySession.get(sessionId);
      if (!target) return;
      this.pathsBySession.delete(sessionId);
      if (
        ![...this.pathsBySession.values()].some(
          (candidate) => canonicalPathKey(candidate) === canonicalPathKey(target)
        )
      ) {
        await this.removeQuietly(target);
        this.log(`[scratch] Released ${redactStderrLine(target)} for session ${sessionId}`);
      } else {
        this.log(
          `[scratch] Kept ${redactStderrLine(target)} after session ${sessionId}: another session still uses it`
        );
      }
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
      // Every root this run has used, not just the current one: changing the
      // temp base path in Settings used to strand everything allocated under
      // the previous root, and "a scratch directory does not survive the app"
      // stopped being true for exactly the sessions that had already started
      // (main-aux-03).
      const roots = new Set([this.rootPath(), ...this.knownRoots]);
      for (const root of roots) await this.removeQuietly(root);
    });
  }

  private async removeQuietly(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      // Cleanup is best-effort by design: a locked file on Windows must not
      // fail an app quit or an archive. The next startup wipe retries it.
      //
      // T066: `console.warn`, not the milestone sink — a directory that could
      // not be removed is an anomaly, and warn is the level that survives with
      // the logging switch off (main/utils/logger.ts). Redacted (T042).
      //
      // 回炉: one argument, not two. An `rm` failure reads `EACCES: permission
      // denied, rmdir '/home/<name>/…'`, and electron-log serializes every
      // argument it is given — so passing `error` alongside a redacted path
      // put the unredacted path on disk anyway.
      console.warn(
        `[scratch] Failed to remove ${redactStderrLine(target)}: ${sanitizeStderrLine(describeError(error))}`
      );
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
