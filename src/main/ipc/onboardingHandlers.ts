/**
 * D47 S1 §1/§2.3 — the real IPC sanitization seam for verify-and-register.
 *
 * `createVerifyAndRegisterHandler` is a pure factory: it takes the service
 * (production wiring passes the real `onboardingService`; tests pass a fake)
 * and returns the exact function `main/ipc/onboarding.ts` hands to
 * `ipcMain.handle`. Tests drive THIS factory directly — not a rule copy — so
 * a mutation that turns `toRendererRegisterResponse` into a passthrough is
 * caught through the real production seam (B-track 1.2).
 */

import type {
  OnboardingErrorCode,
  OnboardingRegisterClientResponse,
  OnboardingVerifyRequest,
} from '@shared/types';
import type { OnboardingRegisterResponse } from '../services/onboarding/types';

export interface VerifyAndRegisterService {
  verifyAndRegister(email: string, code: string): Promise<OnboardingRegisterResponse>;
}

/**
 * Whitelist construction (S1 spec §2.3, A-track M6): every field on the
 * output is named explicitly. An unknown field the server starts sending
 * tomorrow is dropped by default — a delete-style trim would instead leak it.
 */
export function toRendererRegisterResponse(
  full: OnboardingRegisterResponse
): OnboardingRegisterClientResponse {
  if (full.ok && full.data?.user) {
    return {
      ok: true,
      data: { user: { id: full.data.user.id, name: full.data.user.name } },
    };
  }

  const error: OnboardingErrorCode | string | undefined = full.error;
  const attemptsLeft = full.data?.attemptsLeft;
  return {
    ok: false,
    ...(error !== undefined ? { error } : {}),
    ...(attemptsLeft !== undefined ? { data: { attemptsLeft } } : {}),
  };
}

export interface VerifyAndRegisterHooks {
  /**
   * D47 S5 §1.2 login-success trigger — symmetric to logout step ⑦.
   * Production wiring passes `() => getAuthStateService().refresh()`; the
   * value-changed broadcast then kicks the probe scheduler via the auth IPC
   * bridge. Fires only on `ok: true`, after the full response is sanitized.
   * (GUI round 2026-08-15 caught the miss: without this, a fresh login left
   * the gate snapshot at the stale pre-login `signed_out` forever.)
   */
  onSuccess?: () => void;
}

export function createVerifyAndRegisterHandler(
  service: VerifyAndRegisterService,
  hooks: VerifyAndRegisterHooks = {}
) {
  return async (
    _event: unknown,
    request: OnboardingVerifyRequest
  ): Promise<OnboardingRegisterClientResponse> => {
    const full = await service.verifyAndRegister(request.email, request.code);
    const response = toRendererRegisterResponse(full);
    if (response.ok) {
      hooks.onSuccess?.();
    }
    return response;
  };
}
