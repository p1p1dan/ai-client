/**
 * A2 rev.2 — "has the user come through the welcome screen this run".
 *
 * ## Why this exists at all
 *
 * The welcome screen is the startup screen (user ruling, 2026-08-27:
 * 「就是启动首屏，每次都出现」). Every launch shows it and the person picks a
 * way in — `Continue as <email>`, a fresh sign-in, or their own setup. So the
 * gate needs to know one thing that is neither an account fact nor a stored
 * preference: whether that pick has happened YET, in this process.
 *
 * ## Deliberately not persisted
 *
 * Persisting it would silently turn the screen back into "show once", which is
 * exactly the shape the ruling replaced. It resets with the process, so
 * quitting and reopening puts the choice back in front of the user — which is
 * also what makes switching credential sources need no separate entry point.
 *
 * ## Why Main owns it rather than the renderer
 *
 * `MainWindow.isAppMountedFor()` asks the SAME `resolveGateDecision` whether
 * App is mounted, in order to decide whether closing needs a dirty-files
 * confirmation. It has no renderer state to read and must answer
 * synchronously. Keeping the latch here is what lets both call sites keep
 * feeding one pure function — the "换服务两处同变" invariant D47 S5 §1.4 set up.
 */

let enteredThisRun = false;

/** Read by `auth.getGateSnapshot` and by `MainWindow.isAppMountedFor`. */
export function hasEnteredApp(): boolean {
  return enteredThisRun;
}

/** Latched by `auth:enterApp` — the welcome screen's three ways in. */
export function markAppEntered(): void {
  enteredThisRun = true;
}

/** Test-only: module state has to be resettable between cases. */
export function resetAppEntryForTests(): void {
  enteredThisRun = false;
}
