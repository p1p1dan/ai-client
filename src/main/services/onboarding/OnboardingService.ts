import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OnboardingCliStatus,
  OnboardingRegisterResponse,
  OnboardingState,
} from '@shared/types';
import { net } from 'electron';
import { mergeSettingsPatch } from '../../ipc/settings';
import { AgentInstaller } from '../cli/AgentInstaller';
import { cliDetector } from '../cli/CliDetector';

const ALLOWED_EMAIL_SUFFIX = '@jcdz.cc';
const DEFAULT_ONBOARDING_SERVICE_URL = 'https://onboarding-jyw.pipidan.qzz.io';

function getInjectedOnboardingSecret(): string {
  return typeof __ONBOARDING_SECRET__ === 'string' ? __ONBOARDING_SECRET__ : '';
}

function getInjectedOnboardingServiceUrl(): string {
  const injected =
    typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
  return injected || DEFAULT_ONBOARDING_SERVICE_URL;
}

class OnboardingService {
  /**
   * Check if user has already completed onboarding.
   * Reads the onboarding field from ~/.aiclient/settings.json.
   */
  checkRegistration(): OnboardingState {
    try {
      const settingsPath = path.join(os.homedir(), '.aiclient', 'settings.json');
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
      const result = await this.requestRegistration(
        normalizedEmail,
        normalizedServerUrl,
        onboardingSecret
      );

      if (!result.ok || !result.data) {
        return { ok: false, error: result.error || 'Registration failed' };
      }

      if (!this.persistCredentialFiles(result, normalizedServerUrl)) {
        return { ok: false, error: 'Failed to write CLI credentials' };
      }

      const cchServerUrl = this.deriveCchBaseUrl(
        result.data.config.claude.baseUrl,
        normalizedServerUrl
      );

      // Save onboarding state
      const onboardingState: OnboardingState = {
        registered: true,
        email: normalizedEmail,
        serverUrl: cchServerUrl,
        registeredAt: new Date().toISOString(),
      };
      const onboardingSaved = this.saveOnboardingState(onboardingState);
      if (!onboardingSaved) {
        return { ok: false, error: 'Failed to save onboarding state' };
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }
  }

  async refreshRegisteredCredentialFiles(): Promise<boolean> {
    const onboardingState = this.checkRegistration();
    if (!onboardingState.registered || !onboardingState.email || !onboardingState.serverUrl) {
      return false;
    }

    const validation = this.validateEmail(onboardingState.email);
    if (!validation.valid) {
      return false;
    }

    const normalizedEmail = this.normalizeEmail(onboardingState.email);
    const normalizedServerUrl = this.normalizeServerUrl(getInjectedOnboardingServiceUrl());

    try {
      const result = await this.requestRegistration(normalizedEmail, normalizedServerUrl, '');
      if (!result.ok || !result.data) {
        return false;
      }

      return this.persistCredentialFiles(result, normalizedServerUrl);
    } catch (error) {
      console.warn('[OnboardingService] Failed to refresh registered credentials:', error);
      return false;
    }
  }

  /**
   * Logout current user. Clears non-sensitive onboarding state and removes local CLI credentials.
   */
  logout(): boolean {
    try {
      this.removeClaudeCredentials();
      this.removeCodexConfig();
      return mergeSettingsPatch({ onboarding: { registered: false } });
    } catch (error) {
      console.error('[OnboardingService] Failed to logout:', error);
      return false;
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private getCredentialWriteInputs(
    result: OnboardingRegisterResponse,
    normalizedServerUrl: string
  ): {
    claudeBaseUrl: string;
    claudeAuthToken: string;
    codexApiKey: string;
    codexBaseUrl: string;
  } | null {
    const data = result.data;
    if (!data) {
      return null;
    }

    const claudeAuthToken = data.config.claude.authToken;
    const codexApiKey = data.config.codex.apiKey;
    if (!claudeAuthToken || !codexApiKey) {
      return null;
    }

    const claudeBaseUrl = this.buildApiBaseUrl(data.config.claude.baseUrl, normalizedServerUrl);
    const codexBaseUrl = this.buildApiBaseUrl(data.config.codex.baseUrl, normalizedServerUrl);
    return {
      claudeAuthToken,
      claudeBaseUrl,
      codexApiKey,
      codexBaseUrl,
    };
  }

  private async requestRegistration(
    normalizedEmail: string,
    normalizedServerUrl: string,
    onboardingSecret: string
  ): Promise<OnboardingRegisterResponse> {
    const url = `${normalizedServerUrl}/register`;
    const secret = getInjectedOnboardingSecret() || onboardingSecret;
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Onboarding-Secret': secret,
      },
      body: JSON.stringify({ email: normalizedEmail }),
    });

    return (await response.json()) as OnboardingRegisterResponse;
  }

  private persistCredentialFiles(
    result: OnboardingRegisterResponse,
    normalizedServerUrl: string
  ): boolean {
    const credentials = this.getCredentialWriteInputs(result, normalizedServerUrl);
    if (!credentials) {
      return false;
    }

    if (!this.writeClaudeConfig(credentials.claudeBaseUrl, credentials.claudeAuthToken)) {
      return false;
    }
    if (!this.writeCodexConfig(credentials.codexApiKey, credentials.codexBaseUrl)) {
      return false;
    }
    return this.ensureClaudeOnboardingComplete();
  }

  private writeClaudeConfig(baseUrl: string, authToken: string): boolean {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const settingsPath = path.join(claudeDir, 'settings.json');

      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

      const existingSettings = this.readJsonIfExists(settingsPath) as Record<string, unknown>;
      if (fs.existsSync(settingsPath)) {
        fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
      }

      const existingEnv = this.readEnvRecord(existingSettings.env);
      const nextEnv = {
        ...existingEnv,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };

      // Bypass the WebFetch preflight check — its upstream request often fails
      // behind the JYW proxy and blocks users from browsing pages.
      const nextSettings = {
        ...existingSettings,
        env: nextEnv,
        skipWebFetchPreflight: true,
      };
      fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });

      return true;
    } catch (error) {
      console.error('[OnboardingService] Failed to write Claude config:', error);
      return false;
    }
  }

  private writeCodexConfig(apiKey: string, baseUrl: string): boolean {
    try {
      const codexDir = path.join(os.homedir(), '.codex');
      fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });

      const configPath = path.join(codexDir, 'config.toml');
      const authPath = path.join(codexDir, 'auth.json');

      let originalConfig = '';
      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, `${configPath}.bak`);
        originalConfig = fs.readFileSync(configPath, 'utf-8');
      }
      if (fs.existsSync(authPath)) {
        fs.copyFileSync(authPath, `${authPath}.bak`);
      }

      const nextConfig = this.upsertCodexConfigToml(originalConfig, baseUrl);
      fs.writeFileSync(configPath, nextConfig, { encoding: 'utf-8', mode: 0o600 });

      const existingAuth = this.readJsonIfExists(authPath) as Record<string, unknown>;
      const nextAuth = { ...existingAuth, OPENAI_API_KEY: apiKey };
      fs.writeFileSync(authPath, JSON.stringify(nextAuth, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });

      return true;
    } catch (error) {
      console.error('[OnboardingService] Failed to write Codex config:', error);
      return false;
    }
  }

  private upsertCodexConfigToml(original: string, baseUrl: string): string {
    type Block = { header: string | null; bodyLines: string[] };
    type UpsertMode = 'ifMissing' | 'force';
    type UpsertItem = { key: string; literal: string; mode: UpsertMode };
    type UpsertGroup = { section: string | null; items: UpsertItem[] };

    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerRegex = /^\s*\[([^\]]+)\]\s*$/;

    const trimmed = original.endsWith('\n') ? original.slice(0, -1) : original;
    const lines = trimmed === '' ? [] : trimmed.split('\n');

    const blocks: Block[] = [{ header: null, bodyLines: [] }];
    for (const line of lines) {
      const headerMatch = line.match(headerRegex);
      if (headerMatch) {
        blocks.push({ header: headerMatch[1], bodyLines: [] });
      } else {
        blocks[blocks.length - 1].bodyLines.push(line);
      }
    }

    const groups: UpsertGroup[] = [
      {
        section: null,
        items: [{ key: 'model_provider', literal: '"jyw"', mode: 'force' }],
      },
      {
        section: 'model_providers.jyw',
        items: [
          { key: 'name', literal: '"jyw"', mode: 'ifMissing' },
          { key: 'base_url', literal: `"${baseUrl}"`, mode: 'force' },
          { key: 'wire_api', literal: '"responses"', mode: 'ifMissing' },
          { key: 'requires_openai_auth', literal: 'true', mode: 'ifMissing' },
          { key: 'model_context_window', literal: '1000000', mode: 'ifMissing' },
          { key: 'model_auto_compact_token_limit', literal: '9000000', mode: 'ifMissing' },
        ],
      },
    ];

    for (const group of groups) {
      let block = blocks.find((b) => b.header === group.section);
      if (!block) {
        const prev = blocks[blocks.length - 1];
        if (prev.bodyLines.length > 0 && prev.bodyLines[prev.bodyLines.length - 1] !== '') {
          prev.bodyLines.push('');
        }
        block = { header: group.section, bodyLines: [] };
        blocks.push(block);
      }

      for (const item of group.items) {
        const keyRegex = new RegExp(`^\\s*${escapeRegExp(item.key)}\\s*=`);
        const lineIdx = block.bodyLines.findIndex((l) => keyRegex.test(l));

        if (lineIdx >= 0) {
          if (item.mode === 'force') {
            block.bodyLines[lineIdx] = `${item.key} = ${item.literal}`;
          }
        } else {
          block.bodyLines.push(`${item.key} = ${item.literal}`);
        }
      }
    }

    const parts: string[] = [];
    for (const block of blocks) {
      if (block.header !== null) {
        parts.push(`[${block.header}]`);
      }
      for (const line of block.bodyLines) {
        parts.push(line);
      }
    }

    let result = parts.join('\n');
    if (!result.endsWith('\n')) {
      result += '\n';
    }
    return result;
  }

  private ensureClaudeOnboardingComplete(): boolean {
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      const existing = this.readJsonIfExists(claudeJsonPath) as Record<string, unknown>;

      if (existing.hasCompletedOnboarding === true) {
        return true;
      }

      const next = { ...existing, hasCompletedOnboarding: true };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(next, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
      return true;
    } catch (error) {
      console.error('[OnboardingService] Failed to update .claude.json:', error);
      return false;
    }
  }

  private removeClaudeCredentials(): void {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      return;
    }

    const existing = this.readJsonIfExists(settingsPath) as Record<string, unknown>;
    const env = this.readEnvRecord(existing.env);

    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

    const next = { ...existing, env };
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8' });
  }

  private removeCodexConfig(): void {
    const codexDir = path.join(os.homedir(), '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const authPath = path.join(codexDir, 'auth.json');

    try {
      if (fs.existsSync(configPath)) {
        fs.rmSync(configPath, { force: true });
      }
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { force: true });
      }
    } catch (error) {
      console.warn('[OnboardingService] Failed to remove Codex config:', error);
    }
  }

  private readJsonIfExists(jsonPath: string): unknown {
    try {
      if (!fs.existsSync(jsonPath)) {
        return {};
      }
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch (error) {
      console.warn(`[OnboardingService] Failed to read JSON (${jsonPath}):`, error);
      return {};
    }
  }

  private readEnvRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
      return {};
    }
    return { ...(value as Record<string, unknown>) };
  }

  /**
   * Save onboarding state to ~/.aiclient/settings.json
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

  private buildApiBaseUrl(baseUrl: string | undefined, fallbackServerUrl: string): string {
    if (!baseUrl) {
      return this.normalizeServerUrl(`${fallbackServerUrl}/v1`);
    }

    try {
      const parsed = new URL(baseUrl);
      return this.normalizeServerUrl(`${parsed.origin}${parsed.pathname}`);
    } catch {
      const serverOrigin = new URL(fallbackServerUrl).origin;
      const normalizedPath = baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
      return this.normalizeServerUrl(`${serverOrigin}${normalizedPath}`);
    }
  }

  private deriveCchBaseUrl(responseClaudeBaseUrl: string | undefined, fallbackServerUrl: string): string {
    const baseUrl = responseClaudeBaseUrl?.trim() || fallbackServerUrl;
    return this.normalizeServerUrl(baseUrl).replace(/\/v1$/i, '');
  }

  /**
   * Check CLI installation status for Claude and Codex.
   */
  async detectCli(): Promise<OnboardingCliStatus> {
    const installer = new AgentInstaller();
    const [prerequisites, claude, codex] = await Promise.all([
      installer.checkPrerequisites(),
      cliDetector.detectOne('claude'),
      cliDetector.detectOne('codex'),
    ]);

    return {
      ...prerequisites,
      claudeInstalled: claude.installed,
      claudeVersion: claude.version,
      codexInstalled: codex.installed,
      codexVersion: codex.version,
    };
  }
}

export const onboardingService = new OnboardingService();
