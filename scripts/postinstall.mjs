#!/usr/bin/env node
/**
 * Project postinstall hook.
 *
 * Local dev needs `electron-builder install-app-deps` so node-pty / @parcel/watcher
 * are rebuilt against the Electron V8 ABI; otherwise `pnpm dev` crashes on load.
 *
 * CI does NOT need it:
 *   - The packaging step (`electron-builder --win/--linux`) sets `npmRebuild: false`
 *     in electron-builder.yml, so the build doesn't touch native modules either.
 *   - GitHub's windows-latest moved to the windows-2025 image, on which
 *     @electron/rebuild's bundled node-gyp 9.x can't auto-detect the bundled
 *     VS 2022 Enterprise install, and rebuild dies with "Could not find any
 *     Visual Studio installation to use".
 *
 * So: skip install-app-deps on CI. Local dev still runs it.
 */
import { spawnSync } from 'node:child_process';

const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (isCI) {
    console.log(
        '[postinstall] CI detected — skipping `electron-builder install-app-deps`.'
    );
    console.log(
        '[postinstall] Reason: build packaging has npmRebuild:false and CI never runs Electron locally.'
    );
    process.exit(0);
}

const isWindows = process.platform === 'win32';
const cmd = isWindows ? 'electron-builder.cmd' : 'electron-builder';
const result = spawnSync(cmd, ['install-app-deps'], {
    stdio: 'inherit',
    shell: isWindows,
});
process.exit(result.status ?? 1);
