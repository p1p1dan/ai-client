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

// Successful verify-and-register payload. Same shape as legacy /register.
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

export interface OnboardingCliStatus extends OnboardingPrerequisiteStatus {
  claudeInstalled: boolean;
  claudeVersion?: string;
  codexInstalled: boolean;
  codexVersion?: string;
}
