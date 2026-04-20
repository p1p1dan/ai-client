export interface OnboardingState {
  registered: boolean;
  email?: string;
  serverUrl?: string;
  registeredAt?: string;
}

export interface OnboardingRegisterRequest {
  email: string;
  serverUrl: string;
  onboardingSecret: string;
}

export interface OnboardingRegisterResponse {
  ok: boolean;
  error?: string;
  data?: {
    user: { id: number; name: string };
    apiKey: string;
    config: {
      claude: { baseUrl: string; authToken: string };
      codex: { baseUrl: string; apiKey: string };
    };
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
