import type { OnboardingErrorCode } from '@shared/types';

/**
 * D47 S1 §1/§2.3 — the FULL verify-and-register response, as returned by the
 * onboarding server and by `OnboardingService.verifyAndRegister`. Carries
 * real secrets (`apiKey`, `config.claude.authToken`, `config.codex.apiKey`)
 * and therefore must never cross the Main→renderer IPC boundary uncut.
 *
 * This type used to live in `@shared/types/onboarding.ts`, reachable from
 * renderer/preload by construction. It now lives here, in `main` only —
 * `src/main/ipc/onboardingHandlers.ts:toRendererRegisterResponse` is the sole
 * place that turns this into the trimmed `OnboardingRegisterClientResponse`
 * the renderer is allowed to see (mother spec I2; S1 spec §1 structural
 * unreachability, B-track m3).
 */
export interface OnboardingRegisterResponse {
  ok: boolean;
  error?: OnboardingErrorCode | string;
  data?: {
    user: { id: number; name: string };
    apiKey: string;
    config: {
      claude: { baseUrl: string; authToken: string };
      codex: { baseUrl: string; apiKey: string };
    };
    // Verify-only failure context: remaining attempts before code is locked.
    attemptsLeft?: number;
  };
}
