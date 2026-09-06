import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * Static evidence for the half of "end conversation" that lives in `.tsx` and
 * therefore cannot be rendered by this suite (node env, `.ts` only).
 *
 * `endSessionRuntime.test.ts` covers what ending a session DOES. What it cannot
 * see is the wiring: that the control asks first instead of acting, and that the
 * confirm branch is the one calling the detach. Both are exactly the kind of
 * thing a later refactor drops silently — the dialog still closes either way,
 * and the leaked worker is invisible until the machine is out of slots.
 *
 * D12 (U24) moved the control from the center tab's ✕ to the sidebar row's
 * context menu, because the tab strip it hung on is gone. The three claims
 * pinned here did not change with it; only the file they are read from did.
 *
 * Scans read CODE, not prose (shared parser-backed strip).
 */

const NAV_FILE = join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const CODE = stripComments(readFileSync(NAV_FILE, 'utf8'), NAV_FILE);

describe('end-conversation wiring', () => {
  it('routes the menu item through a confirmation instead of ending directly', () => {
    expect(CODE).toContain('setEndConfirmOpen(true)');
    expect(CODE).toContain('<AlertDialog open={endConfirmOpen}');
    // The menu item itself must not carry the detach.
    const menuItem = CODE.slice(
      CODE.indexOf('setEndConfirmOpen(true)'),
      CODE.indexOf('</MenuItem>', CODE.indexOf('setEndConfirmOpen(true)'))
    );
    expect(menuItem).not.toContain('endSessionRuntime');
  });

  it('ends the conversation only from the confirmed branch', () => {
    expect(CODE).toContain('endSessionRuntime(row.sessionId)');
    const dialog = CODE.slice(
      CODE.indexOf('<AlertDialog open={endConfirmOpen}'),
      CODE.indexOf('</AlertDialog>', CODE.indexOf('<AlertDialog open={endConfirmOpen}'))
    );
    expect(dialog).toContain('endSessionRuntime(row.sessionId)');
  });

  it('only offers the action for a session that has a worker to end', () => {
    // On a session that was never started this would be a menu item that does
    // nothing — `endSessionRuntime` would detach a runtime the Host never had.
    expect(CODE).toContain('{started && (');
  });

  it('keeps the dock row: ending is not dismissal, removal or archiving', () => {
    const dialog = CODE.slice(
      CODE.indexOf('<AlertDialog open={endConfirmOpen}'),
      CODE.indexOf('</AlertDialog>', CODE.indexOf('<AlertDialog open={endConfirmOpen}'))
    );
    expect(dialog).not.toContain('markSessionDismissed');
    expect(dialog).not.toContain('onArchive');
    expect(dialog).not.toContain('onClose');
  });
});
