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

export interface OnboardingCliStatus {
  claudeInstalled: boolean;
  claudeVersion?: string;
  codexInstalled: boolean;
  codexVersion?: string;
}
