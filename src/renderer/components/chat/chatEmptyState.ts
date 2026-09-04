/**
 * T12-e — what to show above the composer when it cannot send yet.
 *
 * Before this module all four "cannot send" states shared ONE presentation: a
 * red-bordered, red-tinted, monospace box carrying developer-facing text
 * (`No repository registered — launch with --open-path=<repo> …`). On a fresh
 * install that box is permanently lit, and it reads as "the app is broken"
 * rather than "you have not picked a folder yet" — which was the user report
 * this module answers.
 *
 * The distinction it draws is between a FAILURE and a SETUP STEP:
 *
 *  - `error-notice` — something went wrong, or the app is in a state the user
 *    cannot fix by picking a folder. Keeps the red diagnostic box, because
 *    that IS the right presentation for a fault.
 *  - `welcome` — nothing is wrong; there is simply no working directory yet.
 *    Gets the guided surface with a button that fixes it.
 *  - `none` — the composer can send; nothing sits above it.
 *
 * Order is deliberate and load-bearing: a real error outranks the welcome
 * surface, because an error that arrives while no folder is set must not be
 * swallowed by a cheerful "pick a folder" card that would never mention it.
 */
export interface ChatEmptyStateInput {
  /** A real failure the user should see (`lastError`), not a setup gap. */
  hasError: boolean;
  hasSession: boolean;
  /** A workspace is selected AND it is targetable (a non-empty path). */
  hasWorkspace: boolean;
  /** The resolved working directory the agent would run in. */
  hasCwd: boolean;
  /**
   * U05-b — this chat runs unbound: the user never picked a folder, and Main
   * gives it an isolated throwaway directory on the first send instead. "No
   * folder" is therefore not a setup gap for it, so the welcome surface must
   * not claim the composer.
   *
   * Deliberately a separate input rather than a reinterpretation of
   * `hasCwd`: the guided welcome surface still has to appear for everyone
   * else, and D02 decision 2 is explicit that the unbound path does not reuse
   * welcome's blocking logic.
   */
  unbound?: boolean;
}

export type ChatEmptySurface = 'error-notice' | 'welcome' | 'none';

export function deriveChatEmptySurface(input: ChatEmptyStateInput): ChatEmptySurface {
  // A fault always wins. See the head note: an error raised while no folder is
  // set would otherwise be replaced by a card that cannot mention it.
  if (input.hasError) return 'error-notice';

  // "No folder yet" — the one state the welcome surface can actually resolve.
  // `hasWorkspace` and `hasCwd` are checked separately on purpose: a workspace
  // can be present but not targetable (the demo placeholder carries an empty
  // path so a fake cwd can never reach spawn), and that state is still just
  // "no folder", not a fault.
  // U05-b: an unbound chat skips the folder check entirely — it has no folder
  // BY DESIGN, and gets its own isolated directory when it first sends. It
  // still falls through to the session check below, so a genuinely broken
  // unbound chat keeps the diagnostic box rather than reading as healthy.
  if (!input.unbound && (!input.hasWorkspace || !input.hasCwd)) return 'welcome';

  // Deliberately AFTER the folder check: a missing session is not something
  // "add a working directory" fixes, so it keeps the diagnostic box — but if
  // BOTH are missing, the folder is the step the user can actually take.
  if (!input.hasSession) return 'error-notice';

  return 'none';
}
