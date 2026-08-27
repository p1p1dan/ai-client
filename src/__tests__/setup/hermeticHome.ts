/**
 * Every test process gets its own throwaway `$HOME`.
 *
 * ## Why this exists
 *
 * Before S2 the credential vault lived under `<userData>`, so a test that
 * pointed `app.getPath('userData')` at an `mkdtemp` directory was fully
 * self-contained. S2 moved the vault to `$HOME/.pilab/<profile>/credentials`,
 * where `<profile>` is `<userData>`'s basename — so those same tests started
 * writing real `vault.json` files into the DEVELOPER'S OWN HOME, one directory
 * per temp userData. It was caught by looking at `~/.pilab` after a full run
 * and finding 96 of them.
 *
 * Patching the handful of offenders would have fixed today and not tomorrow:
 * the hazard is structural, because "which paths does this service touch" is
 * exactly the kind of thing a slice like S2 changes. So the fix sits at the
 * boundary — no test process can see the real home, whether or not the author
 * of a given test thought about it.
 *
 * A test that wants its own `$HOME` still overrides `process.env.HOME` and
 * restores it afterwards; it just restores to this sandbox rather than to the
 * real one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const sandboxHome = mkdtempSync(join(tmpdir(), 'aiclient-test-home-'));

process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true });
});
