import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * D12 (U24): the center column shows ONE conversation, and the sidebar states
 * which ones are alive.
 *
 * A reverse guard, in the same spirit as D11's. The tab strip was not a bad
 * implementation — it worked, and it was covered — so the risk is not that it
 * breaks, it is that a later change reintroduces "which chats are open" as a
 * second list beside `activeSessionId`. That second list is what D12 removed:
 * it duplicated a fact the sidebar can state from the runtime, and it drifted
 * from the runtime (a tab could outlive its worker, which is the confusion D09
 * was opened to fix and D12 closed by deleting the carrier).
 */
const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');
const code = (file: string) => stripComments(readFileSync(file, 'utf8'), file);

describe('D12 single-session view', () => {
  it('the tab strip, its store and its model are gone', () => {
    expect(existsSync(join(SHELL_DIR, 'SessionTabs.tsx'))).toBe(false);
    expect(existsSync(join(SHELL_DIR, 'sessionTabsModel.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/renderer/stores/sessionTabs.ts'))).toBe(false);
  });

  it('no open-tab list is mirrored beside activeSessionId', () => {
    const shell = code(join(SHELL_DIR, 'WorkspaceShell.tsx'));
    // The mirror effect and its pruning companion existed only to keep a second
    // list in step with `activeSessionId`. With no second list they would be
    // maintaining nothing.
    expect(shell).not.toContain('openSessionIds');
    expect(shell).not.toContain('useSessionTabsStore');
    expect(shell).toMatch(/<SessionBar\s+presentation=\{presentation\}/);
  });

  it("the sidebar marker reads the runtime's own binding, not a tab list", () => {
    const nav = code(join(SHELL_DIR, 'LeftNav.tsx'));
    // `hostBoundSessionIds` is added by `session.created`/`session.resumed` and
    // removed by `endSessionRuntime` and a capacity reclaim, so the ring means
    // "a worker is attached" rather than "a tab was once opened".
    expect(nav).toContain('hostBoundSessionIds.includes(row.sessionId)');
    expect(nav).not.toContain('openSessionIds');
  });

  it('the session bar keeps the GUI/TUI switch — it has no other home', () => {
    const bar = code(join(SHELL_DIR, 'SessionBar.tsx'));
    expect(bar).toContain('openGui');
    expect(bar).toContain('openTui');
    // And it must NOT grow a close control: D12 put ending a conversation in
    // the sidebar row's menu so the repo's three closes sit together.
    expect(bar).not.toContain('endSessionRuntime');
  });
});
