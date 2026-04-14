import { net } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OnboardingCliStatus,
  OnboardingRegisterResponse,
  OnboardingState,
} from '@shared/types';
import { mergeSettingsPatch } from '../../ipc/settings';
import { cliDetector } from '../cli/CliDetector';
import type { LiveCredentials } from './credentialStore';
import { clearLiveCredentials, setLiveCredentials } from './credentialStore';

const ALLOWED_EMAIL_SUFFIX = '@jcdz.cc';

function getInjectedOnboardingSecret(): string {
  return typeof __ONBOARDING_SECRET__ === 'string' ? __ONBOARDING_SECRET__ : '';
}

class OnboardingService {
  /**
   * Check if user has already completed onboarding.
   * Reads the onboarding field from ~/.ensoai/settings.json.
   */
  checkRegistration(): OnboardingState {
    try {
      const settingsPath = path.join(os.homedir(), '.ensoai', 'settings.json');
      if (!fs.existsSync(settingsPath)) {
        return { registered: false };
      }
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      const onboarding = settings?.onboarding as OnboardingState | undefined;
      if (onboarding?.registered && onboarding?.email) {
        return onboarding;
      }
      return { registered: false };
    } catch {
      return { registered: false };
    }
  }

  /**
   * Validate email format and suffix.
   */
  validateEmail(email: string): { valid: boolean; error?: string } {
    if (!email || typeof email !== 'string') {
      return { valid: false, error: 'Email is required' };
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) {
      return { valid: false, error: 'Invalid email format' };
    }
    if (!trimmed.endsWith(ALLOWED_EMAIL_SUFFIX)) {
      return { valid: false, error: `Only ${ALLOWED_EMAIL_SUFFIX} emails are allowed` };
    }
    return { valid: true };
  }

  /**
   * Register user with the server and persist non-sensitive onboarding state only.
   */
  async register(
    email: string,
    serverUrl: string,
    onboardingSecret: string
  ): Promise<OnboardingRegisterResponse> {
    const validation = this.validateEmail(email);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    const normalizedEmail = this.normalizeEmail(email);
    const normalizedServerUrl = this.normalizeServerUrl(serverUrl);

    try {
      const url = `${normalizedServerUrl}/api/onboarding/register`;
      const secret = getInjectedOnboardingSecret() || onboardingSecret;
      const response = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Onboarding-Secret': secret,
        },
        body: JSON.stringify({ email: normalizedEmail }),
      });

      const result = (await response.json()) as OnboardingRegisterResponse;

      if (!result.ok || !result.data) {
        return { ok: false, error: result.error || 'Registration failed' };
      }

      // Save onboarding state
      const onboardingState: OnboardingState = {
        registered: true,
        email: normalizedEmail,
        serverUrl: normalizedServerUrl,
        registeredAt: new Date().toISOString(),
      };
      const onboardingSaved = this.saveOnboardingState(onboardingState);
      if (!onboardingSaved) {
        return { ok: false, error: 'Failed to save onboarding state' };
      }

      // Cache credentials in main-process memory so the user can open a terminal immediately.
      const credentials = this.mapLiveCredentials(result, normalizedServerUrl);
      if (credentials) {
        setLiveCredentials(credentials);
      } else {
        clearLiveCredentials();
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }
  }

  /**
   * Fetch live credentials from CCH and return them without touching disk.
   *
   * NOTE: This calls the idempotent registration API.
   */
  async fetchLiveCredentials(email: string): Promise<LiveCredentials | null> {
    const validation = this.validateEmail(email);
    if (!validation.valid) {
      return null;
    }

    const onboarding = this.checkRegistration();
    if (!onboarding.registered || !onboarding.serverUrl) {
      return null;
    }

    const normalizedEmail = this.normalizeEmail(email);
    const normalizedServerUrl = this.normalizeServerUrl(onboarding.serverUrl);

    try {
      const url = `${normalizedServerUrl}/api/onboarding/register`;
      const secret = getInjectedOnboardingSecret();
      const response = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Onboarding-Secret': secret,
        },
        body: JSON.stringify({ email: normalizedEmail }),
      });

      const result = (await response.json()) as OnboardingRegisterResponse;
      if (!result.ok || !result.data) {
        return null;
      }

      return this.mapLiveCredentials(result, normalizedServerUrl);
    } catch (error) {
      console.warn('[OnboardingService] Failed to fetch live credentials:', error);
      return null;
    }
  }

  /**
   * Logout current user. Clears non-sensitive onboarding state and in-memory credentials.
   */
  logout(): boolean {
    clearLiveCredentials();
    try {
      return mergeSettingsPatch({ onboarding: { registered: false } });
    } catch (error) {
      console.error('[OnboardingService] Failed to logout:', error);
      return false;
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private mapLiveCredentials(
    result: OnboardingRegisterResponse,
    normalizedServerUrl: string
  ): LiveCredentials | null {
    const data = result.data;
    if (!data) {
      return null;
    }

    const claudeAuthToken = data.config.claude.authToken;
    const codexApiKey = data.config.codex.apiKey;
    if (!claudeAuthToken || !codexApiKey) {
      return null;
    }

    const claudeBaseUrl = this.buildClaudeBaseUrl(normalizedServerUrl);
    const codexBaseUrl = this.buildApiBaseUrl(data.config.codex.baseUrl, normalizedServerUrl);
    return {
      claudeAuthToken,
      claudeBaseUrl,
      codexApiKey,
      codexBaseUrl,
    };
  }

  /**
   * Save onboarding state to ~/.ensoai/settings.json
   */
  private saveOnboardingState(state: OnboardingState): boolean {
    try {
      return mergeSettingsPatch({ onboarding: state });
    } catch (error) {
      console.error('[OnboardingService] Failed to save state:', error);
      return false;
    }
  }

  private normalizeServerUrl(serverUrl: string): string {
    return serverUrl.trim().replace(/\/+$/, '');
  }

  private buildClaudeBaseUrl(fallbackServerUrl: string): string {
    const serverOrigin = new URL(fallbackServerUrl).origin;
    return this.normalizeServerUrl(serverOrigin);
  }

  private buildApiBaseUrl(baseUrl: string | undefined, fallbackServerUrl: string): string {
    const serverOrigin = new URL(fallbackServerUrl).origin;

    if (!baseUrl) {
      return this.normalizeServerUrl(`${serverOrigin}/v1`);
    }

    try {
      const parsed = new URL(baseUrl);
      return this.normalizeServerUrl(`${serverOrigin}${parsed.pathname}`);
    } catch {
      const normalizedPath = baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
      return this.normalizeServerUrl(`${serverOrigin}${normalizedPath}`);
    }
  }

  /**
   * Check CLI installation status for Claude and Codex.
   */
  async detectCli(): Promise<OnboardingCliStatus> {
    const [claude, codex] = await Promise.all([
      cliDetector.detectOne('claude'),
      cliDetector.detectOne('codex'),
    ]);

    return {
      claudeInstalled: claude.installed,
      claudeVersion: claude.version,
      codexInstalled: codex.installed,
      codexVersion: codex.version,
    };
  }
}

export const onboardingService = new OnboardingService();
