import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * The GUI ↔ Pi TUI handover, which both drive the same session JSONL.
 *
 * The bug this guards: leaving the terminal used to only dispose the PTY and
 * flip the mode. Nothing re-read the file, so the timeline still showed the
 * pre-terminal conversation and the still-live worker kept its leaf on the
 * pre-terminal entry — the next GUI turn branched off there and left everything
 * typed in the TUI on an abandoned path.
 *
 * The behaviour lives in a component with no headless entry point, so this
 * scans the source the way `unboundChatWiring.test.ts` does. Comments are
 * stripped first, so prose describing the fix cannot satisfy the scan.
 */

// D07: the handover moved out of `ChatWorkspace.tsx` into
// `usePresentationSwitch.ts` — the GUI/TUI buttons now live in the shell's
// header bar, and `components/chat` may not import `components/workspace-shell`
// (guarded in `composerTargetGuards.test.ts`), so the shell owns one instance of
// the hook and hands it to both. The behaviour asserted below is byte-identical;
// only the file it lives in changed.
const WORKSPACE = stripComments(
  readFileSync(path.join(__dirname, '..', 'usePresentationSwitch.ts'), 'utf8'),
  'usePresentationSwitch.ts'
);
/** The half that still renders the terminal and the timeline it swaps with. */
const CHAT_COLUMN = stripComments(
  readFileSync(path.join(__dirname, '..', 'ChatWorkspace.tsx'), 'utf8'),
  'ChatWorkspace.tsx'
);

describe('leaving the Pi TUI re-reads the session from disk', () => {
  it('reloads the session instead of trusting the timeline it already has', () => {
    expect(WORKSPACE).toContain('window.electronAPI.chat.reloadSession({ sessionId })');
  });

  it('suspends the terminal first, then reloads', () => {
    // Order still matters, but not for the reason this comment used to claim.
    // `suspend` only stops Main from forwarding further PTY output to the
    // renderer (PiTuiPty.ts) — the pi CLI process itself is untouched and
    // keeps appending to the same JSONL. So this reload can still land before
    // a trailing write finishes; it is not reading a file the other writer
    // has stopped appending to. What actually makes this safe to leave as-is
    // is that the next GUI write re-reads the file again before it writes
    // (see the `tuiWrittenSessions` bookkeeping in piTui.ts), so a reload
    // that lands one write behind here is a transient staleness, not a
    // lasting correctness bug.
    expect(WORKSPACE).toMatch(
      /piTui\.suspend\(terminalId\);\s*await window\.electronAPI\.chat\.reloadSession/
    );
  });

  it('keeps the terminal warm on success and only disposes when the reload fails', () => {
    // Suspend-and-reuse is safe only because a GUI send kills terminals on this
    // file first, so a suspended one can never wake onto a file the GUI wrote.
    const openGui = WORKSPACE.slice(
      WORKSPACE.indexOf('const openGui'),
      WORKSPACE.indexOf('useEffect(() => {', WORKSPACE.indexOf('const openGui'))
    );
    expect(openGui).toContain('piTui.suspend(terminalId)');
    expect(openGui).toMatch(/catch \(error\) \{[\s\S]{0,400}piTui\.dispose\(terminalId\)/);
  });

  it('reloads when pi exited on its own, not only when the user left the terminal', () => {
    // session-01: this path used to drop the id and flip the mode, on the
    // reasoning that there was nothing left to suspend. The reload is the half
    // that still applies — the worker is alive holding the tree it read before
    // the terminal appended, so the next GUI write continues from a sequence
    // the file no longer justifies and the file stops opening at all.
    const handleExit = WORKSPACE.slice(
      WORKSPACE.indexOf('const handleTuiExit'),
      WORKSPACE.indexOf('useEffect(() => {', WORKSPACE.indexOf('const handleTuiExit'))
    );
    expect(handleExit).toContain('reloadSession({ sessionId })');
    // Unconditional: this side cannot tell whether the terminal wrote anything.
    expect(handleExit).not.toMatch(/if \([^)]*wrote|if \([^)]*released/);
  });

  it('holds the chat surface until the reload settles', () => {
    expect(WORKSPACE).toContain('setSurfaceSwitching(true)');
    expect(WORKSPACE).toMatch(/finally \{\s*setSurfaceSwitching\(false\);/);
    // D07: the flag is raised in the hook but CONSUMED in the chat column,
    // which still renders the timeline. Asserted on both halves — a flag that
    // is set and never read would leave the pre-TUI timeline on screen during
    // the reload, which is the state this whole handover exists to avoid.
    expect(CHAT_COLUMN).toMatch(/surfaceSwitching && \(/);
  });
});

describe('entering the Pi TUI is refused mid-turn', () => {
  it('checks the turn state before switching mode', () => {
    // Handing the file to the terminal while the worker is mid-write would put
    // two live writers on one JSONL. pix refuses the switch; so do we.
    expect(WORKSPACE).toContain("isSessionBusy(liveStatus ?? 'idle')");
    // Read at click time, not captured at render time: a stale closure would
    // answer "is a turn running" with whatever was true several renders ago.
    expect(WORKSPACE).toMatch(/const liveStatus = useChatSessionsStore\s*\.getState\(\)/);
    const openTui = WORKSPACE.slice(
      WORKSPACE.indexOf('const openTui'),
      WORKSPACE.indexOf('const openGui')
    );
    expect(openTui.indexOf('isSessionBusy')).toBeLessThan(
      openTui.indexOf("setPresentationMode('tui')")
    );
  });
});

/**
 * T065 — the app ships with Simplified Chinese as its default, so an English
 * sentence on screen is a defect (see `src/shared/__tests__/i18nCoverage.test.ts`).
 * The Pi TUI's own notices were the last hardcoded ones in this hook: the
 * DEV-15 point check photographed 「Pi TUI closed / Returned to the GUI
 * session.」 sitting in an otherwise Chinese window.
 */
describe('the Pi TUI notices are translated', () => {
  it('sends the exit toast through the translator instead of hardcoding English', () => {
    expect(WORKSPACE).toContain("title: t('Pi TUI closed')");
    expect(WORKSPACE).toContain("description: t('Returned to the GUI session.')");
  });

  it('translates the refusal Main sends, rather than printing its wire text', () => {
    // D18 and TUI-1 both arrive as `support.reason`. Main has no translator, so
    // the string it sends is a dictionary key and this side is what looks it up
    // (the catalog entries are guarded in `piTuiSession.test.ts`, since a scan
    // for `t('…')` literals cannot see a key held in a variable).
    expect(WORKSPACE).toContain('description: t(support.reason)');
  });
});
