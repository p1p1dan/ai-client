export interface OnboardingState {
  registered: boolean;
  email?: string;
  serverUrl?: string;
  registeredAt?: string;
}

// Machine-readable error codes from the onboarding service. See server contract.
export type OnboardingErrorCode =
  | 'EMAIL_INVALID'
  | 'EMAIL_DOMAIN_NOT_ALLOWED'
  | 'INVALID_BODY'
  | 'RATE_LIMITED'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'CODE_USED'
  | 'CODE_LOCKED'
  | 'SMTP_FAILED'
  | 'CCH_FAILED'
  | 'CCH_UNREACHABLE'
  | 'KEY_NOT_READY'
  | 'INTERNAL_ERROR';

export interface OnboardingSendCodeRequest {
  email: string;
}

export interface OnboardingSendCodeResponse {
  ok: boolean;
  // Either OnboardingErrorCode (machine) or a human message — caller maps to UI string.
  error?: OnboardingErrorCode | string;
  data?: {
    expiresInSec: number;
    resendAfterSec: number;
    retryAfterSec?: number;
  };
}

export interface OnboardingVerifyRequest {
  email: string;
  code: string;
}

/**
 * What the renderer is allowed to see from verify-and-register (D47 S1 §2.3).
 * The full response (with `apiKey`/`config`, real secrets) lives in
 * `src/main/services/onboarding/types.ts` and stays in Main —
 * `onboardingHandlers.ts:toRendererRegisterResponse` is the only place that
 * turns one into the other, via an explicit whitelist construction (never a
 * delete-style trim, so an unexpected new server field is dropped by
 * default rather than leaking through).
 */
export type OnboardingRegisterClientResponse =
  | { ok: true; data: { user: { id: number; name: string } } }
  | { ok: false; error?: OnboardingErrorCode | string; data?: { attemptsLeft?: number } };

export interface OnboardingPrerequisiteStatus {
  gitInstalled: boolean;
  gitVersion?: string;
  nodeInstalled: boolean;
  nodeVersion?: string;
  wingetAvailable: boolean;
}

export type InstallAgentId = 'claude' | 'codex';

export type InstallStepId = 'git' | 'node' | 'claude' | 'codex';

export type InstallStepStatus = 'pending' | 'installing' | 'done' | 'skipped' | 'error';

export interface InstallProgress {
  step: InstallStepId;
  status: InstallStepStatus;
  message?: string;
}

export interface InstallResult {
  success: boolean;
  cancelled?: boolean;
  errors: string[];
}

/**
 * A3 (D65) — outcome of the git-only install offered by the missing-git notice.
 * A result object, not a throw: the caller is a non-blocking notice.
 */
export interface OnboardingInstallGitResult {
  ok: boolean;
  error?: string;
}

export interface OnboardingCliStatus extends OnboardingPrerequisiteStatus {
  claudeInstalled: boolean;
  claudeVersion?: string;
  codexInstalled: boolean;
  codexVersion?: string;
}

/**
 * Outcome of a credential health check. Used by the renderer to decide whether
 * to mount the main App or pull the user back through registration. The check
 * inspects the actual file contents (not just existence): a settings.json that
 * exists but no longer carries ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN is just
 * as broken as a missing file.
 */
export interface OnboardingCredentialsHealth {
  claudeEnvOk: boolean;
  codexAuthOk: boolean;
  /** Free-form reason when something is off — surfaced in logs only. */
  reason?: string;
}
