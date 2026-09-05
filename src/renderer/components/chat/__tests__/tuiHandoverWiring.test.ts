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
    // Order is the correctness point, not a preference: the reload has to read
    // a file the other writer is no longer appending to.
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
