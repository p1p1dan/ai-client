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
import { resolveSpawnGateDecision } from '@shared/authGate';
import { resolveSkipAuthGate } from '@shared/devFlags';
import { app } from 'electron';
import { resolveManagedCredentialsEnabled } from './AuthStateService';
import { getAuthStateService } from './index';

export function assertAgentSpawnAllowed(): void {
  // Fast path, matching `AuthStateService.refresh()`'s flag-off zero-IO
  // philosophy: when managed credentials are off the gate is a pure no-op,
  // so it never even reads `app.isPackaged`/`AuthStateService` — the
  // overwhelming majority of callers (legacy/team-track dev builds) hit this
  // line and return immediately.
  const managed = resolveManagedCredentialsEnabled();
  if (!managed) return;

  const authStateService = getAuthStateService();
  const decision = resolveSpawnGateDecision({
    managed,
    skipAuthGate: resolveSkipAuthGate({ env: process.env, isPackaged: app.isPackaged }),
    authenticatedForSpawn: authStateService.isAuthenticatedForSpawn(),
    state: authStateService.getState(),
  });
  if (!decision.ok) {
    throw new Error(`${decision.error.code}: ${decision.error.message}`);
  }
}
