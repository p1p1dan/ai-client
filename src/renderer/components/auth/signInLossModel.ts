/**
 * What pressing 登录 / 退出登录 actually costs, counted rather than guessed.
 *
 * ## Why this exists
 *
 * `auth:requestSignIn` drops Main's entry latch, `resolveGateDecision` stops
 * answering `app`, and Root unmounts the whole `<App/>` tree. Before that fix
 * nothing could unmount App at all once the user was inside, so no surface ever
 * had to ask first. Now one does, and 「可能会丢失数据」 is not an answer — the
 * user cannot weigh a cost nobody measured.
 *
 * ## What is actually lost, and what is not (2026-09-18 audit)
 *
 * LOST — every terminal, hard:
 *  - A `ShellTerminal` unmounting runs `useXterm`'s teardown → `session.detach`
 *    → `SessionManager.detach` finds no window left attached and, because every
 *    caller leaves `persistOnDisconnect` at its `false` default, calls
 *    `PtyManager.destroy` → `killProcessTree(pty)` with SIGKILL. Whatever was
 *    running (a build, a test run, an install) dies mid-way with no signal it
 *    can handle.
 *  - A Pi TUI terminal is parked by `useXterm` and then disposed for real by
 *    `usePresentationSwitch`'s own unmount cleanup, which walks every live
 *    terminal id. SIGTERM first, SIGKILL if it does not go.
 *  - The tab list itself is `TerminalPanel`'s React `useState`, so even the
 *    record of which terminals existed is gone.
 *
 * HALF LOST — a turn that is in flight. The turn itself is safe: it runs in a
 * forked worker process, `startSend` returns as soon as the worker acks, and
 * the only things that abort it are an explicit `chat.stop`/`chat.closeSession`
 * or the app exiting. Nothing in the unmount path calls any of them.
 *
 * What is lost is the renderer's view of it. `runtimeEventBus` refcounts its
 * IPC listener and detaches when the last subscriber goes, Main buffers
 * nothing and has no replay channel, and on re-entry `useActivateSession` skips
 * re-reading history because the old messages are still in the store. So every
 * event produced while App was unmounted is dropped for good: the assistant
 * text never appears (it IS in the session's JSONL on disk), the session can
 * stay frozen on `running`, and — the sharp edge — a `permission.requested`
 * that lands in the gap leaves the worker parked on a card that will never be
 * drawn. The turn hangs until the user presses Stop.
 *
 * That is why the dialog does NOT say "your chats are unaffected". It was the
 * obvious reassurance to offer, it is what the main process alone would
 * suggest, and it is wrong in the one case the user would most resent.
 *
 * NOT LOST — editor tabs and their unsaved text. `useEditorStore` is a
 * module-level zustand store; unmounting React does not touch it, nothing calls
 * `closeAllFiles`/`clearAllWorktreeStates`, and `useEditorWorktreeSync` skips
 * its `switchWorktree` when the workspace path has not changed. The tabs come
 * back on re-entry with `content`/`isDirty` intact. Chat history is safe the
 * same way, plus the on-disk JSONL.
 *
 * That is exactly why the unsaved-file line is worded as "not written to disk"
 * rather than "will be lost": claiming a loss that does not happen trains the
 * user to click through the next dialog too. The reason it is still worth
 * saying is the OTHER exits from the welcome screen — quitting the app, or
 * signing in as somebody else — where the same unsaved text really does go.
 *
 * Pure and React-free so vitest's node environment covers it directly.
 */

/** A snapshot taken the moment the user pressed the button — never re-read while the dialog is up. */
export interface SignInLossSnapshot {
  /** Editor tabs whose text differs from the file on disk, across every workspace. */
  unsavedFiles: number;
  /** Shell terminals: killed with their whole process tree. */
  shellTerminals: number;
  /** Pi TUI terminals embedded in chat: disposed on the same unmount. */
  agentTerminals: number;
  /** Sessions with a turn in flight: the turn survives, the renderer's view of it does not. */
  runningTurns: number;
}

export interface SignInLossInput {
  /** `useEditorStore`'s live tab list (the workspace currently on screen). */
  tabs: readonly { isDirty: boolean }[];
  /**
   * The per-workspace tabs the store parked when the user switched away. They
   * are just as unsaved, and just as invisible — a count that ignored them
   * would under-report on anyone who works in more than one workspace.
   *
   * The live list is excluded by key: `switchWorktree` writes the current tabs
   * into this map under `currentWorktreePath`, so the same tabs are reachable
   * twice and would otherwise be counted twice.
   */
  parkedTabsByWorkspace: Readonly<Record<string, { tabs: readonly { isDirty: boolean }[] }>>;
  /** `useEditorStore.currentWorktreePath` — the key to skip in the map above. */
  currentWorkspacePath: string | null;
  /** `useTerminalStore.sessions` — every shell tab across every workspace. */
  shellTerminals: number;
  /** `useTerminalWriteStore.writers` — one entry per mounted `AgentTerminal`. */
  agentTerminals: number;
  /** `useChatSessionsStore.sessions` filtered by `isTurnInFlight(status)`. */
  runningTurns: number;
}

function countDirty(tabs: readonly { isDirty: boolean }[]): number {
  let total = 0;
  for (const tab of tabs) {
    if (tab.isDirty) total += 1;
  }
  return total;
}

export function deriveSignInLosses(input: SignInLossInput): SignInLossSnapshot {
  let unsavedFiles = countDirty(input.tabs);
  for (const [path, parked] of Object.entries(input.parkedTabsByWorkspace)) {
    if (path === input.currentWorkspacePath) continue;
    unsavedFiles += countDirty(parked.tabs);
  }
  return {
    unsavedFiles,
    shellTerminals: input.shellTerminals,
    agentTerminals: input.agentTerminals,
    runningTurns: input.runningTurns,
  };
}

/** Terminals of both kinds, which the copy treats as one number. */
export function totalTerminals(snapshot: SignInLossSnapshot): number {
  return snapshot.shellTerminals + snapshot.agentTerminals;
}

/**
 * Whether there is anything to warn about at all.
 *
 * `false` means the dialog is SKIPPED and the request goes straight through —
 * see `signInConfirm.ts`. An empty confirmation box is pure friction: it has no
 * content to weigh, so the only thing it can teach is that these dialogs are
 * noise.
 */
export function hasSignInLosses(snapshot: SignInLossSnapshot): boolean {
  return snapshot.unsavedFiles > 0 || totalTerminals(snapshot) > 0 || snapshot.runningTurns > 0;
}

/** One catalog key + its interpolation params, ready for `t(key, params)`. */
export interface SignInLossLine {
  key: string;
  params?: Record<string, number>;
}

export interface SignInLossLineOptions {
  /**
   * Logging out, not just re-logging-in.
   *
   * Only one line changes, and it has to: `performLogoutSequence` runs
   * `terminateAllSessions()` + `disposeAllPiTuiControllers()` + a worker
   * `invalidateAll()` BEFORE it clears the vault, so the in-flight turn is
   * killed outright rather than left running with nobody watching. Printing the
   * re-login wording here would promise a turn that survives, on the one path
   * where it provably does not.
   */
  terminatesTurns?: boolean;
}

/**
 * The bullet list, ordered by how much the line contradicts what the user
 * already assumes.
 *
 * The running turn comes first for exactly that reason: "the conversation is
 * fine, it runs in the background" is the natural assumption, it is half right,
 * and the half that is wrong (the output never comes back, an authorization
 * request in the gap hangs the turn) is the one they would only discover
 * afterwards. Terminals next — the hardest loss, but also the least surprising
 * one. Unsaved files last: the text itself survives in memory, so this is a
 * "save before you go" nudge rather than a loss.
 *
 * Zero-valued lines are omitted rather than printed as "0 terminals" — a
 * dialog that lists things that are not happening is the vague warning again,
 * padded.
 */
export function signInLossLines(
  snapshot: SignInLossSnapshot,
  options?: SignInLossLineOptions
): SignInLossLine[] {
  const lines: SignInLossLine[] = [];
  if (snapshot.runningTurns > 0) {
    lines.push({
      key: options?.terminatesTurns
        ? '{{count}} chat(s) are mid-turn and will be stopped.'
        : '{{count}} chat(s) are mid-turn. The turn keeps running in the background, but its output will not come back to the screen, and it hangs if it asks for permission while you are away.',
      params: { count: snapshot.runningTurns },
    });
  }
  const terminals = totalTerminals(snapshot);
  if (terminals > 0) {
    lines.push({
      key: '{{count}} terminal(s) will close, and any command still running is force-quit.',
      params: { count: terminals },
    });
  }
  if (snapshot.unsavedFiles > 0) {
    lines.push({
      key: '{{count}} file(s) have unsaved edits that are not on disk yet.',
      params: { count: snapshot.unsavedFiles },
    });
  }
  return lines;
}
