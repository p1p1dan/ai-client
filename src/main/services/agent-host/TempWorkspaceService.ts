/**
 * Recovery for temp workspace directories, the sibling of
 * `ScratchWorkspaceService` for the other kind of directory this app creates.
 *
 * Deliberately its own module rather than part of `ipc/tempWorkspace.ts`: the
 * session paths (`ipc/chat.ts`) need only these two functions, and that IPC
 * module pulls in `SessionManager` — and with it node-pty — which has no
 * business being on the chat module's dependency graph.
 *
 * The two directory kinds differ in who deletes them, not in who creates them:
 * the app wipes the scratch root itself at exit and startup, while a temp
 * workspace only disappears when the user removes it by hand. Both are app
 * *created* content, so both are recreated in place when a session still names
 * one — a chat must not become unopenable because its directory went away.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getEffectiveTemporaryBasePath } from '@shared/defaultPaths';
import { readStringSetting, TEMPORARY_PATH_SETTING_KEY } from '../../ipc/settings';
import { GitService } from '../git/GitService';
import { isDirectChildOf, resolveWorkspacePath } from './workspaceContainment';

/**
 * The temp workspace base as Main sees it.
 *
 * Every IPC entry point in `ipc/tempWorkspace.ts` takes the base from its
 * caller, because the renderer owns the setting. These functions have no such
 * caller, so they read the same setting from Main's own copy; the renderer
 * resolves it identically (`getEffectiveTemporaryBasePath(defaultTemporaryPath)`
 * in `useComposerTarget.ts`), so the two agree.
 *
 * "The same setting" has to come through `readStringSetting`, which unwraps the
 * renderer's persist layer. Taking it off the settings file's top level — as
 * this did until D13 — reads `undefined` on every machine, and the `?? ''`
 * fallback turned that into "the user picked nothing": the self-heal below then
 * measured every path against the DEFAULT root and answered false for a
 * workspace under the root the user had actually chosen.
 */
function settingsBasePath(): string {
  return getEffectiveTemporaryBasePath(
    readStringSetting(TEMPORARY_PATH_SETTING_KEY),
    homedir(),
    path.sep
  );
}

/**
 * True when `candidate` is one of the directories the temp workspace handlers
 * create: a direct child of the temp workspace base.
 *
 * The direct-child rule is the one `TEMP_WORKSPACE_REMOVE` already enforces,
 * and here it is what stops `adoptTempWorkspace` from being able to create an
 * arbitrary directory out of a tampered session-index row.
 *
 * BOTH sides are resolved before they are compared. Only the candidate used to
 * be, while the base was the raw string the user typed into a free-text field
 * in Settings — so a saved location ending in a separator (or holding a `..`
 * segment) made this answer false for every real workspace, which silently
 * switched off the self-heal below (main-aux-07).
 */
export function isTempWorkspacePath(candidate: string): boolean {
  if (!candidate.trim()) return false;
  return isDirectChildOf(settingsBasePath(), candidate);
}

/**
 * Recreate a temp workspace directory that has gone missing, at its recorded
 * path. A no-op for every other kind of path, and for one that is already
 * there with its repo.
 *
 * Reproduces what the create handler does rather than only the `mkdir`: that
 * handler runs `git init` too, and a directory without the repo would not be
 * equivalent to a freshly created workspace.
 */
export async function adoptTempWorkspace(dirPath: string): Promise<void> {
  if (!isTempWorkspacePath(dirPath)) return;
  const resolved = resolveWorkspacePath(dirPath);
  await mkdir(resolved, { recursive: true });
  if (existsSync(path.join(resolved, '.git'))) return;
  await new GitService(resolved).init();
}
