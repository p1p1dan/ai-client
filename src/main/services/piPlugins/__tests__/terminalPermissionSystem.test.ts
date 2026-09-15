/**
 * cutover-02 — what the plugins page is allowed to say about approval.
 *
 * This answer used to be "which permission system approves this app's tool
 * calls", and a user who had installed `@gotgenes/pi-permission-system` was
 * told the app stepped aside and its own approval settings did not apply.
 * Neither half was true after P6-5: a chat is approved by
 * `src/runtime/plugins/permissions/` whatever is installed, and the user's deny
 * rules never ran. What an install DOES decide is the built-in Pi terminal,
 * which runs the real pi CLI out of the same agent directory — so that is the
 * question this function answers now, and `bundled` is no longer one of the
 * answers it can give.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_PLUGIN_PACKAGE } from '../../../../agent-host/permissionPlugin';

// The module reaches electron through its service factory at CALL time only;
// these two keep the import graph loadable in a node test.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' } }));
vi.mock('../../agent-host/WorkerManager', () => ({ workerManager: { invalidateAll: vi.fn() } }));

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutover02-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSettings(value: unknown): void {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(value), 'utf8');
}

describe('terminalPermissionSystemOwner', () => {
  it('reports the user’s own copy when the agent directory declares it', async () => {
    const { terminalPermissionSystemOwner } = await import('../index');
    writeSettings({ packages: [PERMISSION_PLUGIN_PACKAGE] });
    expect(terminalPermissionSystemOwner(dir)).toBe('user_configured');
  });

  it('reports "none" for a first run and for a directory that declares nothing', async () => {
    const { terminalPermissionSystemOwner } = await import('../index');
    // A missing file is the ordinary first-run state.
    expect(terminalPermissionSystemOwner(join(dir, 'never-created'))).toBe('none');
    writeSettings({ packages: ['@some/other-plugin'] });
    expect(terminalPermissionSystemOwner(dir)).toBe('none');
  });

  it('never answers "bundled" — the copy this app ships is not loaded by the CLI', async () => {
    const { terminalPermissionSystemOwner } = await import('../index');
    for (const settings of [
      {},
      { packages: [] },
      { packages: [PERMISSION_PLUGIN_PACKAGE] },
      { packages: ['@some/other-plugin'] },
    ]) {
      writeSettings(settings);
      expect(terminalPermissionSystemOwner(dir)).not.toBe('bundled');
    }
  });

  it('says "unknown" for a file it failed to read rather than guessing', async () => {
    const { terminalPermissionSystemOwner } = await import('../index');
    // Unparseable is not the same as absent: a page that printed "no permission
    // extension" here would state something it did not check.
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf8');
    expect(terminalPermissionSystemOwner(dir)).toBe('unknown');
  });
});
