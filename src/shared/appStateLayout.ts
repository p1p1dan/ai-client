/**
 * The SHAPE of the app's own state directory. Pure: no `electron`, no `fs`,
 * no `os` — every input is a parameter.
 *
 * Plan `unified-credentials` S2. This is split out from
 * `main/services/appStatePaths.ts` (which reads the real roots off `electron`)
 * for one concrete reason: `services/auth/adoption.ts` needs the layout and is
 * contractually a pure module — `adoptionStaticImportBans.test.ts` makes that
 * promise executable. It already receives `<userData>` as an argument, so with
 * these functions it can resolve a root without importing anything new.
 *
 * ## The profile layer
 *
 * The local root is `~/.pilab/<profile>/`, never `~/.pilab/` directly, and
 * `<profile>` is `<userData>`'s own basename.
 *
 * Until S2 the credential vault lived under `<userData>`, and Electron already
 * gave dev builds their own (`…/jyw-ai-client-dev`). That suffix was doing
 * real work: a dev build could not write the release build's credentials, and
 * `cchBaseUrl` could not swing between the test gateway and the real one
 * behind the user's back. Moving the vault into `$HOME` throws that isolation
 * away unless it is re-created deliberately — so `<profile>` IS that suffix,
 * kept alive under a different roof (open-q #1).
 *
 * Deriving it from `<userData>` rather than re-inventing it means there is one
 * answer to "which install am I", and `AICLIENT_PROFILE=foo` moves both roots
 * together with no second rule to keep in sync.
 */

import { APP_STATE_DIR, LEGACY_APP_STATE_DIR } from './defaultPaths';

/** Sub-directory of the profile root that holds `vault.json`. */
export const CREDENTIALS_DIR_NAME = 'credentials';

/**
 * `<userData>`'s directory name in a PACKAGED build, pinned rather than
 * inherited from `productName`.
 *
 * Electron would otherwise name it after the product — "PiLab Ai" since the
 * 1.0.0-test.17 rename — and `<profile>` is that directory's basename, so the
 * space would land in every path the app writes: `~/.pilab/PiLab Ai/...`, the
 * vault included. A space-free name keeps those paths quotable in the shell
 * scripts and agent commands that receive them (user decision, 2026-09-21).
 *
 * `main/index.ts` applies it with `app.setPath('userData', …)` before anything
 * reads a path; dev builds keep their own `<name>-<profile>` directory.
 */
export const PACKAGED_USER_DATA_DIR_NAME = 'PiLabAi';

/**
 * `<userData>` directory names earlier PACKAGED releases wrote under, newest
 * first. Each one is a former `productName`, and each is a place this install's
 * own state may still be sitting: `~/.pilab/<name>` for the S2 layout, and
 * `<appData>/<name>/credentials` for the vault's pre-S2 home.
 *
 * Read only by the migration — see `main/services/appStateMigration.ts`. A
 * normal reader that fell back to these would never notice the copy failed.
 */
export const PRIOR_USER_DATA_DIR_NAMES = ['AiClient'];

/** Last path segment of `<userData>` — see "The profile layer" above. */
function profileSegment(userDataDir: string): string {
  const segments = userDataDir.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/**
 * `~/.pilab/<profile>` — the root every LOCAL reader and writer should use.
 *
 * Segments are joined with `/` rather than `node:path`, because this module is
 * under `shared/` and must stay importable without a Node builtin (the same
 * constraint `defaultPaths.ts` states). Node's fs APIs accept forward slashes
 * on Windows, and every caller passes the result straight into `path.join`,
 * which normalises it.
 */
export function buildAppStateRoot(homeDir: string, userDataDir: string): string {
  return [homeDir, APP_STATE_DIR, profileSegment(userDataDir)].filter(Boolean).join('/');
}

/**
 * `~/.aiclient` — the pre-rename root. It has no profile layer because it
 * never had one, and the migration depends on exactly that: both the release
 * build and the dev build read the same legacy directory.
 */
export function buildLegacyAppStateRoot(homeDir: string): string {
  return [homeDir, LEGACY_APP_STATE_DIR].filter(Boolean).join('/');
}
