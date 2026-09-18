import { describe, expect, it } from 'vitest';
import {
  deriveSignInLosses,
  hasSignInLosses,
  type SignInLossInput,
  type SignInLossSnapshot,
  signInLossLines,
  totalTerminals,
} from '../signInLossModel';

/**
 * The counting behind 「3 个文件有未保存的修改」.
 *
 * The user's ruling on the `a72e0337` regression was "先弹确认框，列明会丢什么"
 * — the whole value of the dialog is in the numbers being right, so they are
 * asserted here rather than eyeballed in the GUI. Pure functions, node env, no
 * mount.
 */

const EMPTY: SignInLossInput = {
  tabs: [],
  parkedTabsByWorkspace: {},
  currentWorkspacePath: null,
  shellTerminals: 0,
  agentTerminals: 0,
  runningTurns: 0,
};

const NOTHING: SignInLossSnapshot = deriveSignInLosses(EMPTY);

describe('deriveSignInLosses', () => {
  it('counts only the dirty tabs of the workspace on screen', () => {
    const losses = deriveSignInLosses({
      ...EMPTY,
      tabs: [{ isDirty: true }, { isDirty: false }, { isDirty: true }],
    });
    expect(losses.unsavedFiles).toBe(2);
  });

  it('includes tabs parked under OTHER workspaces — they are unsaved and invisible', () => {
    const losses = deriveSignInLosses({
      ...EMPTY,
      currentWorkspacePath: '/repo-a',
      tabs: [{ isDirty: true }],
      parkedTabsByWorkspace: {
        '/repo-b': { tabs: [{ isDirty: true }, { isDirty: true }] },
        '/repo-c': { tabs: [{ isDirty: false }] },
      },
    });
    expect(losses.unsavedFiles).toBe(3);
  });

  it('does not double-count the live workspace, which the store also parks by path', () => {
    // `switchWorktree` writes the current tabs into `worktreeStates` under
    // `currentWorktreePath`, so the same two tabs are reachable twice. A naive
    // sum would report four unsaved files where there are two.
    const tabs = [{ isDirty: true }, { isDirty: true }];
    const losses = deriveSignInLosses({
      ...EMPTY,
      currentWorkspacePath: '/repo-a',
      tabs,
      parkedTabsByWorkspace: { '/repo-a': { tabs } },
    });
    expect(losses.unsavedFiles).toBe(2);
  });

  it('carries the terminal and turn counts through untouched', () => {
    const losses = deriveSignInLosses({
      ...EMPTY,
      shellTerminals: 2,
      agentTerminals: 1,
      runningTurns: 4,
    });
    expect(losses).toEqual({
      unsavedFiles: 0,
      shellTerminals: 2,
      agentTerminals: 1,
      runningTurns: 4,
    });
    // The copy treats both terminal kinds as one number: both die on the same
    // unmount, and "2 shells and 1 agent terminal" is a distinction the user
    // has no decision to make about.
    expect(totalTerminals(losses)).toBe(3);
  });
});

describe('hasSignInLosses — the gate that decides whether a dialog appears at all', () => {
  it('is false when there is nothing to warn about', () => {
    // Nothing open, nothing running: the confirmation is skipped entirely and
    // the request goes straight through. An empty dialog has no content to
    // weigh and only teaches the user to click past the next one.
    expect(hasSignInLosses(NOTHING)).toBe(false);
  });

  it.each([
    ['an unsaved file', { unsavedFiles: 1 }],
    ['a shell terminal', { shellTerminals: 1 }],
    ['an embedded agent terminal', { agentTerminals: 1 }],
    ['a turn in flight', { runningTurns: 1 }],
  ])('is true for %s on its own', (_label, partial) => {
    expect(hasSignInLosses({ ...NOTHING, ...partial })).toBe(true);
  });
});

describe('signInLossLines', () => {
  it('prints nothing when there is nothing to print', () => {
    expect(signInLossLines(NOTHING)).toEqual([]);
  });

  it('omits the zero rows instead of padding the list with them', () => {
    const lines = signInLossLines({ ...NOTHING, shellTerminals: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0].params).toEqual({ count: 2 });
  });

  it('leads with the running turn, because that is the line that contradicts what the user assumes', () => {
    const lines = signInLossLines({
      unsavedFiles: 3,
      shellTerminals: 1,
      agentTerminals: 1,
      runningTurns: 1,
    });
    expect(lines.map((line) => line.params?.count)).toEqual([1, 2, 3]);
    expect(lines[0].key).toContain('mid-turn');
    expect(lines[1].key).toContain('terminal');
    expect(lines[2].key).toContain('unsaved');
  });

  it('never promises a surviving turn on the logout path, where it provably does not survive', () => {
    const snapshot = { ...NOTHING, runningTurns: 2 };
    const reLogin = signInLossLines(snapshot)[0].key;
    const logout = signInLossLines(snapshot, { terminatesTurns: true })[0].key;

    // Re-login leaves the worker alive; logout runs `terminateAllSessions()`
    // and invalidates the worker before it clears the vault.
    expect(reLogin).toContain('keeps running in the background');
    expect(logout).not.toContain('keeps running');
    expect(logout).toContain('stopped');
    // Same fact counted, two different consequences.
    expect(signInLossLines(snapshot, { terminatesTurns: true })[0].params).toEqual({ count: 2 });
  });

  it('keeps every line in the Chinese catalog — the app ships zh by default', async () => {
    const { zhTranslations } = await import('@shared/i18n');
    const full: SignInLossSnapshot = {
      unsavedFiles: 1,
      shellTerminals: 1,
      agentTerminals: 0,
      runningTurns: 1,
    };
    for (const line of [
      ...signInLossLines(full),
      ...signInLossLines(full, { terminatesTurns: true }),
    ]) {
      expect(zhTranslations, line.key).toHaveProperty([line.key]);
      // A key whose placeholder was dropped in translation would silently print
      // a sentence with no number in it — exactly the vague warning this
      // dialog replaces.
      expect(zhTranslations[line.key], line.key).toContain('{{count}}');
    }
  });
});
