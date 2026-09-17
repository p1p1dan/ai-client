import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';
import { piTuiOpenRefusalKey } from '../piTuiOpenError';

/**
 * Which chat the embedded Pi terminal is actually attached to.
 *
 * Two audit findings, one subject. terminal-03: the terminal id was created
 * once per app run, so switching chats inside terminal mode left the same
 * `pi --session A.jsonl` on screen while the header, the session bar and the
 * timeline all said B — everything the user typed went into A's file.
 * terminal-04: the call that revives a parked terminal omitted the session
 * file, so whenever the PTY was already gone (pi failed on startup, capacity
 * evicted it, something else disposed it) Main took the "new terminal" branch
 * and started a blank `pi` bound to no chat at all, outside every guard and
 * every "the GUI must re-read this file" record.
 *
 * Both live in React hooks with no headless entry point, so this scans the
 * source the way `tuiHandoverWiring.test.ts` does. Comments are stripped first,
 * so prose describing the fix cannot satisfy the scan.
 */
const SWITCH = stripComments(
  readFileSync(
    path.join(__dirname, '..', '..', 'components', 'chat', 'usePresentationSwitch.ts'),
    'utf8'
  ),
  'usePresentationSwitch.ts'
);
const XTERM = stripComments(
  readFileSync(path.join(__dirname, '..', 'useXterm.ts'), 'utf8'),
  'useXterm.ts'
);

/** The effect that re-opens a parked terminal when it becomes active again. */
const REVIVE_ANCHOR = 'if (!piTuiTerminalId || isLoading || !ptyIdRef.current) return;';
function reviveEffect(): string {
  const start = XTERM.indexOf(REVIVE_ANCHOR);
  expect(start, 'the revive effect moved; this scan needs a new anchor').toBeGreaterThan(-1);
  const depsAt = XTERM.indexOf('}, [', start);
  return XTERM.slice(start, XTERM.indexOf(']', depsAt) + 1);
}

describe('[terminal-03] the terminal id belongs to a chat, not to the app', () => {
  it('keeps one id per session instead of a single app-wide one', () => {
    // The shape that caused it: `current ?? crypto.randomUUID()` reused the
    // first id forever, and only a workspace-path change ever cleared it.
    expect(SWITCH).not.toMatch(/setTuiTerminalId\(\(current\) => current \?\?/);
    expect(SWITCH).toMatch(/const \[tuiTerminalIds, setTuiTerminalIds\] = useState</);
  });

  it('reads the active chat s own id, so switching chats changes the terminal', () => {
    expect(SWITCH).toMatch(/tuiTerminalIds\[activeSessionId\]/);
  });

  it('files a newly started terminal under the chat it was started for', () => {
    const openTui = SWITCH.slice(SWITCH.indexOf('const openTui'), SWITCH.indexOf('const openGui'));
    expect(openTui).toMatch(/\[activeSessionId\]: `pi-tui-\$\{crypto\.randomUUID\(\)\}`/);
  });

  it('forgets only the chat whose terminal ended', () => {
    const handleExit = SWITCH.slice(
      SWITCH.indexOf('const handleTuiExit'),
      SWITCH.indexOf('useEffect(() => {', SWITCH.indexOf('const handleTuiExit'))
    );
    expect(handleExit).toContain('forgetTerminal(sessionId)');
    expect(handleExit).not.toContain('setTuiTerminalIds({})');
  });

  it('still disposes every terminal it opened when the surface goes away', () => {
    expect(SWITCH).toMatch(
      /Object\.values\([a-zA-Z.]*[Tt]erminalIds[a-zA-Z.]*\)[\s\S]{0,160}piTui\.dispose\(terminalId\)/
    );
  });
});

/**
 * D17 (T065 回炉) — the renderer half of the repaint.
 *
 * Main deliberately leaves a resumed PTY one row off the requested size, and
 * this side is what puts the true size back, in a separate IPC message, once
 * the rebuilt xterm is attached. The first attempt did both halves inside one
 * synchronous turn in Main; the point check found the screen still blank and
 * only 10 bytes flowing back, because a child that is scheduled once, after
 * both ioctls, reads a winsize identical to its own.
 */
describe('[D17] the renderer confirms its size after attaching, so pi repaints', () => {
  it('sends the size the attached xterm actually has', () => {
    expect(XTERM).toMatch(
      /function confirmPiTuiSize\(terminalId: string, terminal: Terminal\)[\s\S]{0,200}piTui\s*\.resize\(terminalId, terminal\.cols, terminal\.rows\)/
    );
  });

  it('sends it after the open resolves, not before the terminal exists', () => {
    // Order is the whole point: sent from here rather than from Main so the
    // full frame pi paints cannot arrive before the xterm that has to show it.
    expect(XTERM).toMatch(
      /setCurrentSessionId\(opened\.terminalId\);\s*confirmPiTuiSize\(piTuiTerminalId, terminal\);/
    );
  });

  it('sends it on the revive too, which is the path a chat switch actually takes', () => {
    // Switching back to a parked chat re-opens through the effect below, not
    // through the first open — leaving it out would leave the screen blank in
    // exactly the case the defect was reported on.
    expect(reviveEffect()).toContain('confirmPiTuiSize(piTuiTerminalId, terminal)');
  });
});

/**
 * T065 回炉 — a refused open has to say so.
 *
 * Main refuses with sentences that double as dictionary keys, and only the
 * pre-flight in `usePresentationSwitch` ever displayed one. The D4 re-verify
 * clicked 「Start Pi TUI」 twice in a second window and got no terminal and no
 * message: both paths that reach `piTui.open` directly threw the reason away.
 */
describe('[T065] the refusal Main sends reaches the user', () => {
  it('unwraps the key Electron buried in its invoke wrapper', () => {
    expect(
      piTuiOpenRefusalKey(
        new Error(
          "Error invoking remote method 'pi-tui:open': Error: This chat is already open in a terminal in another window"
        )
      )
    ).toBe('This chat is already open in a terminal in another window');
    // And the key it returns is one the dictionary answers — the point of
    // unwrapping at all.
    expect(
      zhTranslations['This chat is already open in a terminal in another window']
    ).toBeTruthy();
  });

  it('passes anything it does not recognise through as itself', () => {
    // Reverse check: `translate` falls back to its key, so an unknown failure
    // degrades to its own English text rather than to a blank toast.
    expect(piTuiOpenRefusalKey(new Error('node-pty exploded'))).toBe('node-pty exploded');
    expect(piTuiOpenRefusalKey('plain string')).toBe('plain string');
  });

  it('toasts the refusal through the translator on the open path', () => {
    expect(XTERM).toContain('if (piTuiTerminalId) reportPiTuiOpenFailure(error);');
    expect(XTERM).toMatch(
      /title: translate\('The Pi TUI cannot open this chat'\),\s*description: translate\(piTuiOpenRefusalKey\(error\)\)/
    );
  });

  it('no longer swallows the revive rejection whole', () => {
    // Only the open's own chain: the `suspend` call in the same effect keeps
    // its silent catch, which is correct — parking a terminal is not something
    // the user asked for and cannot fail in a way they can act on.
    const effect = reviveEffect();
    const openChain = effect.slice(effect.indexOf('.open({'));
    expect(openChain).toContain('.catch(reportPiTuiOpenFailure)');
    expect(openChain).not.toContain('.catch(() => {})');
  });
});

describe('[terminal-04] reviving a parked terminal names the chat it belongs to', () => {
  it('passes the session file on the revive open, not only on the first one', () => {
    expect(reviveEffect()).toContain('sessionFile: piTuiSessionFile');
  });

  it('re-runs when the chat it is bound to changes', () => {
    const effect = reviveEffect();
    expect(effect.slice(effect.lastIndexOf('}, ['))).toContain('piTuiSessionFile');
  });

  it('keeps the first open bound as well', () => {
    // The original call already carried it; this pins that the two stay in step.
    expect(XTERM.match(/sessionFile: piTuiSessionFile/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
