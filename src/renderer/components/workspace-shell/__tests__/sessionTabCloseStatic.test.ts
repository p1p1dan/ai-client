import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * Static evidence for the half of "close tab = end conversation" that lives in
 * `.tsx` and therefore cannot be rendered by this suite (node env, `.ts` only).
 *
 * `closeSessionTab.test.ts` covers what ending a session does. What it cannot
 * see is the wiring: that the X asks first instead of acting, and that the
 * confirm branch is the one calling the detach. Both are exactly the kind of
 * thing a later refactor drops silently — the tab still disappears either way,
 * and the leaked worker is invisible until the machine is out of slots.
 *
 * Scans read CODE, not prose (shared parser-backed strip).
 */

const TABS_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/SessionTabs.tsx');
const CODE = stripComments(readFileSync(TABS_FILE, 'utf8'), TABS_FILE);

describe('SessionTabs close wiring', () => {
  it('routes the tab X through a confirmation instead of closing directly', () => {
    expect(CODE).toContain('onClose={() => setPendingClose(tab)}');
    expect(CODE).toContain('<AlertDialog');
  });

  it('ends the conversation only from the confirmed branch', () => {
    expect(CODE).toContain('endSessionForTab');
    // The detach sits inside confirmClose, which the dialog's action button
    // calls — not in the tab's own onClose.
    const confirmBody = CODE.slice(
      CODE.indexOf('const confirmClose'),
      CODE.indexOf('return (', CODE.indexOf('const confirmClose'))
    );
    expect(confirmBody).toContain('endSessionForTab');
    expect(confirmBody).toContain('closeTab(sessionId)');
  });

  it('keeps the dock row: no dismissal or row removal from the tab strip', () => {
    expect(CODE).not.toContain('markSessionDismissed');
    expect(CODE).not.toContain('removeSessionRow');
    expect(CODE).not.toContain('archiveSession');
  });
});
