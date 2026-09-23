/**
 * Where the app's own state lives on THIS machine — the `electron`-reading
 * half of the S2 layout. The shape itself, and the reasoning behind the
 * profile layer, live in the pure `@shared/appStateLayout`.
 *
 * ## Lazy, never module scope
 *
 * `app.setPath('userData', …)` runs during `main/index.ts` module evaluation,
 * and ESM hoists imports ahead of it. A root captured at import time would be
 * the pre-override one — the same trap `services/auth/index.ts`'s lazy vault
 * factory documents. Every function here reads `app.getPath` when CALLED.
 *
 * ## What is NOT here
 *
 * Remote paths. `MANAGED_REMOTE_RUNTIME_DIR` and the generated helper's own
 * paths are `APP_STATE_DIR` with no profile layer, because they name
 * directories on somebody else's machine — see `defaultPaths.ts`.
 */

import { join } from 'node:path';
import {
  buildAppStateRoot,
  buildLegacyAppStateRoot,
  CREDENTIALS_DIR_NAME,
  PRIOR_USER_DATA_DIR_NAMES,
} from '@shared/appStateLayout';
import { app } from 'electron';

export { CREDENTIALS_DIR_NAME };

/**
 * `$HOME` the way every pre-S2 caller resolved it. `process.env.HOME` first is
 * not decoration: `SharedSessionState`, `RemoteAuthBroker` and
 * `RemoteConnectionManager` all resolved it that way, and a test (or a Windows
 * shell) that overrides `HOME` must keep moving the root with it.
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || app.getPath('home');
}

/** `~/.pilab/<profile>` — the root every local reader and writer should use. */
export function getAppStateRoot(): string {
  return buildAppStateRoot(resolveHome(), app.getPath('userData'));
}

/** `~/.aiclient` — for the migration, and for adoption's "never migrated" fallback. Nothing else. */
export function getLegacyAppStateRoot(): string {
  return buildLegacyAppStateRoot(resolveHome());
}

/** One earlier `productName`'s pair of roots, as the migration consumes them. */
export interface PriorInstallRoots {
  /** `~/.pilab/<former productName>` — that release's S2 profile root. */
  root: string;
  /** `<appData>/<former productName>/credentials` — the vault's pre-S2 home under that release. */
  credentialsDir: string;
}

/**
 * Where a packaged install's state sits under each name this app shipped
 * before `PACKAGED_USER_DATA_DIR_NAME`, newest first.
 *
 * The product rename (`AiClient` -> `PiLab Ai`, 1.0.0-test.17) moved
 * `<userData>`, and `<profile>` is derived from it — so without this an
 * existing tester would boot the new build into an empty root and be asked to
 * log in again. Callers pass it to `migrateAppState`; nothing else may read it.
 */
export function getPriorInstallRoots(): PriorInstallRoots[] {
  const home = resolveHome();
  const appData = app.getPath('appData');
  return PRIOR_USER_DATA_DIR_NAMES.map((name) => ({
    root: buildAppStateRoot(home, name),
    credentialsDir: join(appData, name, CREDENTIALS_DIR_NAME),
  }));
}

/**
 * `<appData>/<former name>` for each earlier packaged release, newest first —
 * the `<userData>` those releases ran under, which still holds their
 * `Local Storage` (repository list) and `session-index.json` (conversation
 * list). Passed to `migratePriorUserData`; nothing else may read it.
 */
export function getPriorUserDataDirs(): string[] {
  const appData = app.getPath('appData');
  return PRIOR_USER_DATA_DIR_NAMES.map((name) => join(appData, name));
}

/** `~/.pilab/<profile>/credentials`, the vault's home since S2 (it was `<userData>/credentials`). */
export function getCredentialsDir(): string {
  return join(getAppStateRoot(), CREDENTIALS_DIR_NAME);
}
