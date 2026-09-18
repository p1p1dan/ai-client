/**
 * The "you are about to leave the app" prompt that now sits in front of every
 * sign-in request.
 *
 * ## Why a promise store instead of a dialog per call site
 *
 * Five surfaces ask for the sign-in screen (the account card's button, the
 * account card's logout, two cards in the message timeline, one in the embedded
 * terminal) and a sixth asks automatically when credentials go invalid. The
 * confirmation is the same question in all of them, so it is asked in one
 * place: `useSignInRequest` awaits this, and a single `<SignInConfirmHost/>`
 * mounted in `App.tsx` renders the dialog. Same shape as
 * `stores/unsavedPrompt.ts`, which solves the identical problem for closing a
 * dirty editor tab.
 *
 * ## Fail-closed when no host is mounted
 *
 * A promise nobody can resolve would hang the button forever, which is the
 * silent no-op this whole area was just fixed for. So a request made with no
 * host mounted resolves `'unavailable'` immediately and the caller says so out
 * loud. Fail-OPEN was the other option and is worse: it would route away — and
 * kill the user's terminals — precisely when the safety net is missing.
 * `authGateWiring.test.ts` pins the host's presence in `App.tsx` so the
 * fail-closed path is a bug report, not a normal state.
 */

import { create } from 'zustand';
import { deriveSignInLosses, type SignInLossSnapshot } from '@/components/auth/signInLossModel';
// A leaf module by construction (no store, no React, no registry import), so
// reading it from a store cannot start an import cycle.
import { isTurnInFlight } from '@/components/chat/turnHead';
import { useChatSessionsStore } from './chatSessions';
import { useEditorStore } from './editor';
import { useTerminalStore } from './terminal';
import { useTerminalWriteStore } from './terminalWrite';

/**
 * Which question the dialog asks.
 *
 * - `confirm` — the user pressed a button. Cancelling leaves everything exactly
 *   as it was.
 * - `session-expired` — nobody pressed anything; the credentials went invalid
 *   and Main pushed the news. Same losses, different framing, and a deferral
 *   rather than a cancel (see `SignInConfirmDialog`).
 */
export type SignInPromptKind = 'confirm' | 'session-expired';

export type SignInConfirmOutcome = 'granted' | 'declined' | 'unavailable';

const EMPTY_SNAPSHOT: SignInLossSnapshot = {
  unsavedFiles: 0,
  shellTerminals: 0,
  agentTerminals: 0,
  runningTurns: 0,
};

interface SignInConfirmState {
  open: boolean;
  kind: SignInPromptKind;
  /**
   * Frozen at request time. Re-reading the stores while the dialog is up would
   * let the numbers move under the sentence the user is in the middle of
   * reading — a background agent finishing a turn must not silently change
   * what they are agreeing to.
   */
  snapshot: SignInLossSnapshot;
  /** How many `<SignInConfirmHost/>` are mounted. Normally exactly one. */
  hosts: number;
}

export const useSignInConfirmStore = create<SignInConfirmState>(() => ({
  open: false,
  kind: 'confirm',
  snapshot: EMPTY_SNAPSHOT,
  hosts: 0,
}));

let resolver: ((outcome: SignInConfirmOutcome) => void) | null = null;

/** Called by the host's mount effect; returns its own unregister. */
export function registerSignInConfirmHost(): () => void {
  useSignInConfirmStore.setState((state) => ({ hosts: state.hosts + 1 }));
  return () => {
    useSignInConfirmStore.setState((state) => ({ hosts: Math.max(0, state.hosts - 1) }));
    // A host that disappears while its own dialog is open would strand the
    // awaiting caller. Treat it the same as never having had one.
    if (resolver && useSignInConfirmStore.getState().hosts === 0) {
      resolveSignInConfirmation('unavailable');
    }
  };
}

/**
 * Read the live stores once.
 *
 * Exported so a test can assert the wiring (which store feeds which field)
 * without mounting anything; the counting itself is `deriveSignInLosses`.
 */
export function readSignInLosses(): SignInLossSnapshot {
  const editor = useEditorStore.getState();
  return deriveSignInLosses({
    tabs: editor.tabs,
    parkedTabsByWorkspace: editor.worktreeStates,
    currentWorkspacePath: editor.currentWorktreePath,
    shellTerminals: useTerminalStore.getState().sessions.length,
    // One entry per mounted `AgentTerminal` — it registers its writer on mount
    // and unregisters on unmount, so the map size is the live count.
    agentTerminals: useTerminalWriteStore.getState().writers.size,
    // Every session, not just the visible one: a background chat's events are
    // dropped by exactly the same unmount, and the user has no other way to
    // find out.
    runningTurns: useChatSessionsStore
      .getState()
      .sessions.filter((session) => isTurnInFlight(session.status)).length,
  });
}

/**
 * Ask. Resolves `'granted'` only after the user says yes.
 *
 * A second request while one is already up resolves `'declined'` rather than
 * replacing the first: two stacked prompts for the same act would leave the
 * first caller's promise dangling.
 */
export function requestSignInConfirmation(
  kind: SignInPromptKind,
  snapshot: SignInLossSnapshot
): Promise<SignInConfirmOutcome> {
  if (useSignInConfirmStore.getState().hosts === 0) {
    return Promise.resolve('unavailable');
  }
  if (resolver) {
    return Promise.resolve('declined');
  }
  useSignInConfirmStore.setState({ open: true, kind, snapshot });
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

export function resolveSignInConfirmation(outcome: SignInConfirmOutcome): void {
  const current = resolver;
  resolver = null;
  useSignInConfirmStore.setState({ open: false, snapshot: EMPTY_SNAPSHOT });
  current?.(outcome);
}

/** Test-only: module-level resolver state has to be resettable between cases. */
export function resetSignInConfirmForTests(): void {
  resolver = null;
  useSignInConfirmStore.setState({
    open: false,
    kind: 'confirm',
    snapshot: EMPTY_SNAPSHOT,
    hosts: 0,
  });
}
