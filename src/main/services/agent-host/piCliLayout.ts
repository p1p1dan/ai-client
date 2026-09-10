/**
 * Where this process's artifacts are, as the pi CLI launcher needs them.
 *
 * One function rather than the same five-field literal at each call site: the
 * embedded TUI and the plugin manager both launch the bundled CLI, and a
 * packaged-layout fix applied to one copy and not the other is a bug that only
 * shows up in a build nobody runs from source.
 *
 * Read when CALLED, never at module scope — `app.getAppPath()` and
 * `process.resourcesPath` are only meaningful after Electron is up.
 */

import type { PiTuiLaunchLayout } from '@shared/types/piTui';
import { app } from 'electron';

export function currentPiCliLayout(): PiTuiLaunchLayout {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    electronExecPath: process.execPath,
  };
}
