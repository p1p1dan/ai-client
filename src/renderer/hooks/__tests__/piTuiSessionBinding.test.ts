import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

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
