import { net } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OnboardingCliStatus,
  OnboardingRegisterResponse,
  OnboardingState,
} from '@shared/types';
import { cliDetector } from '../cli/CliDetector';
import { applyProvider } from '../claude/ClaudeProviderManager';

const ALLOWED_EMAIL_SUFFIX = '@jcdz.cc';

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
   * Register user with the server, apply configs locally.
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

    try {
      const url = `${serverUrl.replace(/\/$/, '')}/api/onboarding/register`;
      const response = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Onboarding-Secret': onboardingSecret,
        },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const result = (await response.json()) as OnboardingRegisterResponse;

      if (!result.ok || !result.data) {
        return { ok: false, error: result.error || 'Registration failed' };
      }

      // Apply Claude Code CLI configuration
      this.applyClaudeConfig(
        result.data.config.claude.baseUrl,
        result.data.config.claude.authToken
      );

      // Apply Codex CLI configuration
      this.applyCodexConfig(result.data.config.codex.baseUrl, result.data.config.codex.apiKey);

      // Save onboarding state
      this.saveOnboardingState({
        registered: true,
        email: email.trim().toLowerCase(),
        serverUrl,
        registeredAt: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }
  }

  /**
   * Apply Claude Code CLI configuration by writing to ~/.claude/settings.json
   */
  private applyClaudeConfig(baseUrl: string, authToken: string): void {
    applyProvider({
      id: 'jyw-hub',
      name: 'JYW Hub',
      baseUrl,
      authToken,
    });
  }

  /**
   * Apply Codex CLI configuration by writing env vars to ~/.codex/env.json
   */
  private applyCodexConfig(baseUrl: string, apiKey: string): void {
    try {
      const codexDir = path.join(os.homedir(), '.codex');
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
      }
      const configPath = path.join(codexDir, 'env.json');
      const config = { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: baseUrl };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('[OnboardingService] Failed to apply Codex config:', error);
    }
  }

  /**
   * Save onboarding state to ~/.ensoai/settings.json
   */
  private saveOnboardingState(state: OnboardingState): void {
    try {
      const settingsDir = path.join(os.homedir(), '.ensoai');
      const settingsPath = path.join(settingsDir, 'settings.json');

      let settings: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      } else if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
      }

      settings.onboarding = state;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('[OnboardingService] Failed to save state:', error);
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
