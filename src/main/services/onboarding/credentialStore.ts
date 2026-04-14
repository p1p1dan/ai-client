export interface LiveCredentials {
  claudeBaseUrl: string;
  claudeAuthToken: string;
  codexApiKey: string;
  codexBaseUrl: string;
}

let liveCredentials: LiveCredentials | null = null;

export function setLiveCredentials(credentials: LiveCredentials): void {
  liveCredentials = credentials;
}

export function getLiveCredentials(): LiveCredentials | null {
  return liveCredentials;
}

export function clearLiveCredentials(): void {
  liveCredentials = null;
}

