/**
 * D47 S5 §3 — the agent-session-only spawn gate, shared by
 * `main/ipc/chat.ts` (`CHAT_CREATE_SESSION`/`CHAT_RESUME_SESSION`) and
 * `SessionManager.create`'s `kind === 'agent'` arm — "换服务两处同变" applies
 * here too, one function both call sites share.
 *
 * Throws a plain `Error` whose `.message` is `${code}: ${message}`:
 * Electron's `ipcRenderer.invoke` only reliably preserves a thrown Error's
 * `.message` text across the IPC boundary (custom fields like `.error.code`
 * do not survive), so the renderer's error-mapping layer
 * (`renderer/components/chat/authRequiredError.ts`) pattern-matches against
 * that text rather than a structured object arriving intact.
 */
import { resolveSpawnCredentialMode, resolveSpawnGateDecision } from '@shared/authGate';
import { resolveSkipAuthGate } from '@shared/devFlags';
import { app } from 'electron';
import { getAppEntryMode } from './appEntry';
import { resolveManagedCredentialsEnabled } from './credentialMode';
import { getAuthStateService } from './index';

export function assertAgentSpawnAllowed(): void {
  // Fast path, matching `AuthStateService.refresh()`'s flag-off zero-IO
  // philosophy: a run on the user's own setup makes the gate a pure no-op,
  // so it never even reads `app.isPackaged`/`AuthStateService` — the
  // overwhelming majority of callers (legacy/team-track dev builds, and every
  // `Use my own setup` run) hit this line and return immediately.
  //
  // T-A2b: `entryMode` is what the user picked on the welcome screen THIS run;
  // `managed` is the stored choice standing in for it before they have picked.
  // `resolveSpawnCredentialMode` is shared with the decision below so this
  // shortcut cannot answer differently from the gate it is shortcutting.
  const entryMode = getAppEntryMode();
  const managed = resolveManagedCredentialsEnabled();
  if (resolveSpawnCredentialMode({ entryMode, managed }) === 'local') return;

  const authStateService = getAuthStateService();
  const decision = resolveSpawnGateDecision({
    entryMode,
    managed,
    skipAuthGate: resolveSkipAuthGate({ env: process.env, isPackaged: app.isPackaged }),
    authenticatedForSpawn: authStateService.isAuthenticatedForSpawn(),
    state: authStateService.getState(),
  });
  if (!decision.ok) {
    throw new Error(`${decision.error.code}: ${decision.error.message}`);
  }
}
