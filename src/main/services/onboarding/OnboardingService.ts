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
import { applyProvider } from '../claude/ClaudeProviderManager';

const ALLOWED_EMAIL_SUFFIX = '@jcdz.cc';
const LOCAL_CONFIG_VALIDATION_ERROR = 'Local Claude/Codex configuration validation failed';
const CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

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

      const normalizedServerUrl = this.normalizeServerUrl(serverUrl);
      const claudeBaseUrl = this.resolveClaudeBaseUrl(
        result.data.config.claude.baseUrl,
        normalizedServerUrl
      );
      const codexBaseUrl = this.resolveCodexBaseUrl(
        result.data.config.codex.baseUrl,
        normalizedServerUrl
      );

      // Apply Claude Code CLI configuration
      const claudeConfigured = this.applyClaudeConfig(claudeBaseUrl, result.data.config.claude.authToken);

      // Apply Codex CLI configuration
      const codexConfigured = this.applyCodexConfig(codexBaseUrl, result.data.config.codex.apiKey);

      // Save onboarding state
      const onboardingState = {
        registered: true,
        email: email.trim().toLowerCase(),
        serverUrl: normalizedServerUrl,
        registeredAt: new Date().toISOString(),
      };
      const onboardingSaved = this.saveOnboardingState(onboardingState);

      if (
        !claudeConfigured ||
        !codexConfigured ||
        !onboardingSaved ||
        !this.validateLocalConfiguration(
          onboardingState,
          claudeBaseUrl,
          result.data.config.claude.authToken,
          codexBaseUrl,
          result.data.config.codex.apiKey
        )
      ) {
        return { ok: false, error: LOCAL_CONFIG_VALIDATION_ERROR };
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }
  }

  /**
   * Apply Claude Code CLI configuration by writing to ~/.claude/settings.json
   */
  private applyClaudeConfig(baseUrl: string, authToken: string): boolean {
    return applyProvider({
      id: 'jyw-hub',
      name: 'JYW Hub',
      baseUrl,
      authToken,
    });
  }

  /**
   * Apply Codex CLI configuration by writing config.toml and auth.json.
   */
  private applyCodexConfig(baseUrl: string, apiKey: string): boolean {
    try {
      if (!apiKey) {
        return false;
      }
      const codexDir = path.join(os.homedir(), '.codex');
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
      }

      const configPath = path.join(codexDir, 'config.toml');
      const authPath = path.join(codexDir, 'auth.json');
      const envPath = path.join(codexDir, 'env.json');

      this.backupFileIfExists(configPath);
      this.backupFileIfExists(authPath);
      this.backupFileIfExists(envPath);

      fs.writeFileSync(configPath, this.buildCodexConfigToml(baseUrl), { mode: 0o600 });
      fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2), {
        mode: 0o600,
      });

      if (fs.existsSync(envPath)) {
        fs.rmSync(envPath);
      }
      return true;
    } catch (error) {
      console.error('[OnboardingService] Failed to apply Codex config:', error);
      return false;
    }
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

  private validateLocalConfiguration(
    onboardingState: OnboardingState,
    claudeBaseUrl: string,
    claudeAuthToken: string,
    codexBaseUrl: string,
    codexApiKey: string
  ): boolean {
    const savedOnboardingState = this.checkRegistration();
    return (
      savedOnboardingState.registered === true &&
      savedOnboardingState.email === onboardingState.email &&
      this.validateClaudeConfig(claudeBaseUrl, claudeAuthToken) &&
      this.validateCodexConfig(codexBaseUrl, codexApiKey)
    );
  }

  private validateClaudeConfig(baseUrl: string, authToken: string): boolean {
    if (!authToken) {
      return false;
    }
    try {
      const settingsPath = this.getClaudeSettingsPath();
      if (!fs.existsSync(settingsPath)) {
        return false;
      }
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        env?: Record<string, string | undefined>;
      };
      return (
        settings.env?.ANTHROPIC_BASE_URL === baseUrl &&
        settings.env?.ANTHROPIC_AUTH_TOKEN === authToken &&
        settings.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ===
          CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC
      );
    } catch {
      return false;
    }
  }

  private validateCodexConfig(baseUrl: string, apiKey: string): boolean {
    if (!apiKey) {
      return false;
    }
    try {
      const codexDir = path.join(os.homedir(), '.codex');
      const configPath = path.join(codexDir, 'config.toml');
      const authPath = path.join(codexDir, 'auth.json');
      if (!fs.existsSync(configPath) || !fs.existsSync(authPath)) {
        return false;
      }

      const configContent = fs.readFileSync(configPath, 'utf-8');
      const authContent = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
        OPENAI_API_KEY?: string;
      };

      return (
        configContent.includes('model_provider = "cch"') &&
        configContent.includes('model = "gpt-5.2"') &&
        configContent.includes(`base_url = "${baseUrl}"`) &&
        authContent.OPENAI_API_KEY === apiKey
      );
    } catch {
      return false;
    }
  }

  private normalizeServerUrl(serverUrl: string): string {
    return serverUrl.trim().replace(/\/+$/, '');
  }

  private resolveClaudeBaseUrl(baseUrl: string | undefined, fallbackServerUrl: string): string {
    return this.normalizeServerUrl(baseUrl || fallbackServerUrl);
  }

  private resolveCodexBaseUrl(baseUrl: string | undefined, fallbackServerUrl: string): string {
    return this.normalizeServerUrl(baseUrl || `${fallbackServerUrl}/v1`);
  }

  private getClaudeSettingsPath(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(configDir, 'settings.json');
  }

  private buildCodexConfigToml(baseUrl: string): string {
    return [
      'model_provider = "cch"',
      'model = "gpt-5.2"',
      'model_reasoning_effort = "xhigh"',
      'disable_response_storage = true',
      'sandbox_mode = "workspace-write"',
      'windows_wsl_setup_acknowledged = true',
      '',
      '[features]',
      'plan_tool = true',
      'apply_patch_freeform = true',
      'view_image_tool = true',
      'web_search_request = true',
      'unified_exec = false',
      'streamable_shell = false',
      'rmcp_client = true',
      '',
      '[model_providers.cch]',
      'name = "cch"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
      '[sandbox_workspace_write]',
      'network_access = true',
      '',
    ].join('\n');
  }

  private backupFileIfExists(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const backupsDir = path.join(path.dirname(filePath), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backupPath = path.join(backupsDir, `${path.basename(filePath)}.${timestamp}.bak`);
    fs.copyFileSync(filePath, backupPath);
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
