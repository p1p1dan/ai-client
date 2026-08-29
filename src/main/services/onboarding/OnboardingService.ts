import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OnboardingCliStatus,
  OnboardingCredentialsHealth,
  OnboardingSendCodeResponse,
  OnboardingState,
} from '@shared/types';
import { net } from 'electron';
import { mergeSettingsPatch } from '../../ipc/settings';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled, setCredentialMode } from '../auth/credentialMode';
import { redactLogArgs } from '../auth/redact';
import { AgentInstaller } from '../cli/AgentInstaller';
import { cliDetector } from '../cli/CliDetector';
import type { OnboardingRegisterResponse } from './types';

const ALLOWED_EMAIL_SUFFIXES = ['@jcdz.cc', '@wuhanjingce.com'] as const;
const DEFAULT_ONBOARDING_SERVICE_URL = 'https://onboarding-jyw.pipidan.qzz.io';

function getInjectedOnboardingServiceUrl(): string {
  const injected = typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
  return injected || DEFAULT_ONBOARDING_SERVICE_URL;
}

/**
 * D47 S6 §2 (A-M5) — pure surgical removal for the flag-off logout path:
 * deletes only `OPENAI_API_KEY` from an already-parsed `~/.codex/auth.json`
 * object, preserving every other field (a user's own unrelated keys, or a
 * ChatGPT-OAuth `tokens` block). Replaces the old `fs.rmSync(authPath)`
 * full-file delete, which destroyed bytes this app never wrote. Pure: takes
 * and returns a plain object, no filesystem access.
 */
export function removeOpenAiApiKey(authObj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...authObj };
  delete next.OPENAI_API_KEY;
  return next;
}

/**
 * D47 S6 §2 (A-M5) — pure surgical removal for the flag-off logout path:
 * removes only the `[model_providers.jyw]` table this app itself writes
 * (the write side that put it there, deleted with S3), preserving every other table,
 * root-level key, comment, and blank line a user's own `config.toml` may
 * carry. The top-level `model_provider = "jyw"` root line is removed ONLY
 * when its value is EXACTLY `"jyw"` — deleting a differently-valued root
 * line would silently fall the user's own chosen provider back to
 * `api.openai.com`; leaving a `model_provider = "jyw"` root line pointing at
 * a now-removed table would hard-error the CLI on next launch. If the file
 * has no `[model_providers.jyw]` table at all (a real-machine shape seen
 * during S6 evidence-gathering: `[model_providers.OpenAI]`), this function
 * is a complete no-op. Pure: string in, string out, no filesystem access.
 */
export function removeJywProviderFromToml(toml: string): string {
  const headerRegex = /^\s*\[([^\]]+)\]\s*$/;
  const jywRootLineRegex = /^\s*model_provider\s*=\s*"jyw"\s*$/;

  if (toml === '') {
    return toml;
  }

  const trimmed = toml.endsWith('\n') ? toml.slice(0, -1) : toml;
  const lines = trimmed.split('\n');

  const kept: string[] = [];
  let skippingJywTable = false;

  for (const line of lines) {
    const headerMatch = line.match(headerRegex);
    if (headerMatch) {
      skippingJywTable = headerMatch[1] === 'model_providers.jyw';
      if (skippingJywTable) {
        continue;
      }
      kept.push(line);
      continue;
    }
    if (skippingJywTable) {
      continue;
    }
    if (jywRootLineRegex.test(line)) {
      continue;
    }
    kept.push(line);
  }

  const result = kept.join('\n');
  if (result === '') {
    return '';
  }
  return result.endsWith('\n') ? result : `${result}\n`;
}

class OnboardingService {
  /**
   * Check if user has already completed onboarding.
   * Reads the onboarding field from the app state root's settings.json.
   */
  checkRegistration(): OnboardingState {
    try {
      const settingsPath = path.join(getAppStateRoot(), 'settings.json');
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
   * Validate email format and suffix against the allow-list.
   */
  validateEmail(email: string): { valid: boolean; error?: string } {
    if (!email || typeof email !== 'string') {
      return { valid: false, error: 'Email is required' };
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes('@')) {
      return { valid: false, error: 'Invalid email format' };
    }
    const ok = ALLOWED_EMAIL_SUFFIXES.some((suffix) => trimmed.endsWith(suffix));
    if (!ok) {
      return {
        valid: false,
        error: `Only ${ALLOWED_EMAIL_SUFFIXES.join(' / ')} emails are allowed`,
      };
    }
    return { valid: true };
  }

  getAllowedEmailSuffixes(): readonly string[] {
    return ALLOWED_EMAIL_SUFFIXES;
  }

  /**
   * Step 1: ask the onboarding service to email a verification code.
   * Pure RPC; no local state mutation.
   */
  async sendCode(email: string): Promise<OnboardingSendCodeResponse> {
    const validation = this.validateEmail(email);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    const normalizedEmail = this.normalizeEmail(email);
    const serverUrl = this.normalizeServerUrl(getInjectedOnboardingServiceUrl());

    try {
      const response = await net.fetch(`${serverUrl}/api/onboarding/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      return (await response.json()) as OnboardingSendCodeResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }
  }

  /**
   * Step 2: verify the code and persist credentials returned by the server.
   * On success the user is considered onboarded and CLI config files are written.
   */
  async verifyAndRegister(email: string, code: string): Promise<OnboardingRegisterResponse> {
    const validation = this.validateEmail(email);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    const normalizedEmail = this.normalizeEmail(email);
    const normalizedServerUrl = this.normalizeServerUrl(getInjectedOnboardingServiceUrl());

    let result: OnboardingRegisterResponse;
    try {
      const response = await net.fetch(
        `${normalizedServerUrl}/api/onboarding/verify-and-register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail, code: code.trim() }),
        }
      );
      result = (await response.json()) as OnboardingRegisterResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: `Failed to connect to server: ${message}` };
    }

    if (!result.ok || !result.data) {
      return result;
    }

    // Defensive guard: the server may answer ok=true while the response body
    // is missing required Claude / Codex credentials. Catch that here so we
    // don't hand a partially-populated payload to the vault and end up
    // storing garbage that every later spawn would then inject.
    const claudeAuthToken = result.data.config?.claude?.authToken;
    const codexApiKey = result.data.config?.codex?.apiKey;
    if (
      typeof claudeAuthToken !== 'string' ||
      claudeAuthToken.length === 0 ||
      typeof codexApiKey !== 'string' ||
      codexApiKey.length === 0
    ) {
      console.error(
        `[OnboardingService] verifyAndRegister received ok=true but credentials are incomplete; dataKeys=${Object.keys(
          result.data
        ).join(',')}`
      );
      return {
        ok: false,
        error: 'Server returned success without complete credentials',
      };
    }

    // D47 S6 §2 / S3 — there is no dual write left to stop. The legacy writers
    // (`persistCredentialFiles` → writeClaudeConfig / writeCodexConfig /
    // ensureClaudeOnboardingComplete) are DELETED: they wrote the user's own
    // `~/.claude/settings.json` and `~/.codex/*`, which is precisely what D60
    // and S0' spent two slices removing, and after the line below no login can
    // reach them anyway. `saveOnboardingState` a few lines down is unaffected —
    // `onboarding.serverUrl` is still written every login, because the local
    // arm of the gate and adoption's corroborating source both read it (A-M3).
    //
    // D64/S3 — signing in IS choosing managed credentials. Recorded before any
    // branch below reads the mode, so a machine that was in `local` cannot take
    // half of each path: write the user's own `~/.claude/settings.json` (the
    // legacy behaviour) AND skip the vault. It is also what makes the choice
    // durable — the next launch resolves to `managed` without asking again.
    setCredentialMode('managed');

    const cchServerUrl = this.deriveCchBaseUrl(
      result.data.config.claude.baseUrl,
      normalizedServerUrl
    );

    const onboardingState: OnboardingState = {
      registered: true,
      email: normalizedEmail,
      serverUrl: cchServerUrl,
      registeredAt: new Date().toISOString(),
    };
    if (!this.saveOnboardingState(onboardingState)) {
      return { ok: false, error: 'Failed to save onboarding state' };
    }

    // Shadow write (D47 S1 §2.7): vault.save only when managed credentials
    // are on; a vault failure is logged and never blocks the legacy-write
    // success this method has already committed to returning.
    if (resolveManagedCredentialsEnabled()) {
      await this.saveVaultShadowCopy(
        result,
        normalizedServerUrl,
        normalizedEmail,
        cchServerUrl,
        onboardingState.registeredAt ?? new Date().toISOString()
      );

      // D60 removed the Claude regenerate; S0' removed the Codex one. NEITHER
      // agent has a file to write any more — both credentials reach the Agent
      // Host as env, read fresh from the vault on every spawn — so the Host
      // restart below is now the ENTIRE propagation mechanism rather than the
      // last step of one.
      //
      // I5 epoch barrier (A-track M10, a hard AWAIT since D47 S3b): the
      // renderer must not observe login success while a Host that cached the
      // old (or absent) credential env is still alive. Dropping it here means
      // the very next `ensureStarted()` spawns one that reads the vault this
      // login just wrote.
      await this.shutdownAgentHostAfterRegenerate();
    }

    return result;
  }

  /**
   * Lazily imports `agentHostManager` (D47 S2a M10 wiring) instead of a
   * static top-level import: `AgentHostManager.ts` pulls in a much heavier
   * dependency graph (process spawning, logger, etc.) that this repo's
   * vitest node environment can hang on importing eagerly (see sibling
   * `__tests__` files' `vi.mock('electron', ...)` scope). A dynamic import
   * keeps that cost paid only when managed credentials are actually on and a
   * regenerate actually ran.
   *
   * Name kept from when a regenerate preceded it (S0' removed the last one):
   * this is still "the shutdown that makes a credential change take effect",
   * and renaming it would break the trail from the I5 barrier's own notes.
   */
  private async shutdownAgentHostAfterRegenerate(): Promise<void> {
    try {
      const { agentHostManager } = await import('../agent-host/AgentHostManager');
      await agentHostManager.shutdown();
    } catch (error) {
      console.warn('[OnboardingService] Failed to shut down agent host after regenerate:', error);
    }
  }

  private async saveVaultShadowCopy(
    result: OnboardingRegisterResponse,
    normalizedServerUrl: string,
    normalizedEmail: string,
    cchServerUrl: string,
    receivedAt: string
  ): Promise<void> {
    const credentials = this.getCredentialWriteInputs(result, normalizedServerUrl);
    if (!credentials || !result.data) {
      return;
    }

    try {
      const saveResult = await getCredentialVault().save({
        identity: { email: normalizedEmail, userId: result.data.user.id },
        cchBaseUrl: cchServerUrl,
        claude: { baseUrl: credentials.claudeBaseUrl, authToken: credentials.claudeAuthToken },
        codex: { baseUrl: credentials.codexBaseUrl, apiKey: credentials.codexApiKey },
        pi: { baseUrl: credentials.codexBaseUrl, apiKey: credentials.codexApiKey },
        receivedAt,
      });
      if (!saveResult.ok) {
        console.warn(
          ...redactLogArgs([`[OnboardingService] vault.save skipped: ${saveResult.reason}`])
        );
      }
    } catch (error) {
      // Shadow write only — never let a vault failure surface as a
      // verifyAndRegister rejection (S1 spec §2.7).
      console.warn(
        ...redactLogArgs(['[OnboardingService] vault.save threw; ignoring (shadow write)', error])
      );
    }
  }

  /**
   * Logout current user — the LEGACY (flag-agnostic) half only: removes
   * local `~/.claude`/`~/.codex` CLI credential files and merges
   * `onboarding.registered = false` into the app state root's settings.json.
   *
   * D47 S5 §3 I9 restructure: the vault clear, managed-home regenerate, and
   * Agent Host shutdown steps MOVED OUT to
   * `main/ipc/onboarding.ts`'s `performLogoutSequence()`, which awaits each
   * one explicitly as its own checkpoint (④⑤③) instead of this method
   * kicking off a fire-and-forget promise a caller had to remember to await
   * separately (the old `pendingLogoutRegeneratePromise` /
   * `awaitPendingLogoutRegenerate()` pair, now retired). `logout()` keeps its
   * synchronous `boolean` signature — `performLogoutSequence()` calls it as
   * one step among its own explicitly-sequenced ones.
   *
   * D47 S5 §0-3 bug fix: the settings merge now explicitly re-pastes `email`
   * — `mergeSettingsPatch` is a SHALLOW top-level merge
   * (`{...base, ...patch}`), so a bare `{onboarding:{registered:false}}`
   * patch REPLACES the whole `onboarding` object and silently drops `email`,
   * breaking the flag-off pre-fill that depends on `onboarding.email`
   * surviving a logout. D47 S6 §2 (A-m7) widens this re-paste to
   * `serverUrl`/`registeredAt` too — the same shallow-merge drop applied to
   * those two keys, confirmed on this machine.
   *
   * D47 S6 §2 — flag-on: `removeClaudeCredentials`/`removeCodexConfig` are
   * SKIPPED (the company token deliberately stays at `~/.claude`/`~/.codex`
   * after a flag-on logout — U1 "留置", so an outside terminal keeps working;
   * see the logout dialog copy, A-m9). The `mergeSettingsPatch` call below is
   * NEVER flag-gated — `registered:false` is the SECOND latch against silent
   * re-adoption after logout (the first is §1.5's marker-present +
   * vault-not-absent skip in `ensureVaultAdoption`); skipping it here would
   * let a logged-out managed machine get silently re-adopted on next boot.
   */
  logout(): boolean {
    try {
      const currentRegistration = this.checkRegistration();
      const email = currentRegistration.registered ? currentRegistration.email : undefined;
      const serverUrl = currentRegistration.registered ? currentRegistration.serverUrl : undefined;
      const registeredAt = currentRegistration.registered
        ? currentRegistration.registeredAt
        : undefined;

      // S3 — unconditional, where it used to run only in the legacy arm.
      //
      // These remove keys only WE ever wrote: `ANTHROPIC_BASE_URL` /
      // `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
      // from the user's `settings.json`, and the `[model_providers.jyw]` table
      // from their `config.toml`. Current builds never write them — but builds
      // before S3 did, and this is the ONLY path that undoes it. Gated on the
      // mode, a user who upgrades and then signs out would keep our gateway
      // pinned in their own config forever, with nothing left that could clear
      // it. Both removers are surgical rewrites, never deletes, so a file with
      // none of our keys in it comes back unchanged.
      this.removeClaudeCredentials();
      this.removeCodexConfig();
      return mergeSettingsPatch({
        onboarding: { registered: false, email, serverUrl, registeredAt },
      });
    } catch (error) {
      console.error('[OnboardingService] Failed to logout:', error);
      return false;
    }
  }

  /**
   * Logout's managed-side work — now nothing, and kept as an explicit no-op.
   *
   * It used to leave codex-home's `config.toml` untouched while deleting its
   * stale `auth.json`; D60 had already removed the Claude half. S0' removed the
   * codex home itself, so there is no file to leave alone and none to delete.
   *
   * A logged-out app simply stops handing a credential to the next Host spawn.
   * That is strictly SAFER than what it replaced — the credential never sat in
   * a file that a failed logout could leave behind.
   *
   * Kept rather than deleted because `performLogoutSequence()` documents an
   * ORDERED set of checkpoints and this is one of them; its position (strictly
   * after checkpoint ③'s Host shutdown, per the I9 restructure "shutdown 从
   * regenerate 链尾摘出") is a fact about that sequence. Remove it when the
   * sequence is re-examined, not as a side effect of this slice.
   */
  async regenerateManagedHomesForLogout(): Promise<void> {
    const { clearManagedPiCredential } = await import('../piModelConfig');
    clearManagedPiCredential();
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
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8' });
  }

  /**
   * D47 S6 §2 (A-M5) — surgical, not full-file: `[model_providers.jyw]`
   * (+ the conditional `model_provider` root line) is stripped out of
   * `config.toml` via `removeJywProviderFromToml`, and `OPENAI_API_KEY`
   * alone is stripped out of `auth.json` via `removeOpenAiApiKey` — both
   * files are REWRITTEN, never `fs.rmSync`'d, so a user's own unrelated
   * provider tables / keys / comments survive a flag-off logout intact.
   */
  private removeCodexConfig(): void {
    const codexDir = path.join(os.homedir(), '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const authPath = path.join(codexDir, 'auth.json');

    try {
      if (fs.existsSync(configPath)) {
        const original = fs.readFileSync(configPath, 'utf-8');
        const next = removeJywProviderFromToml(original);
        if (next !== original) {
          fs.writeFileSync(configPath, next, { encoding: 'utf-8' });
        }
      }
      if (fs.existsSync(authPath)) {
        const existingAuth = this.readJsonIfExists(authPath) as Record<string, unknown>;
        const nextAuth = removeOpenAiApiKey(existingAuth);
        fs.writeFileSync(authPath, `${JSON.stringify(nextAuth, null, 2)}\n`, {
          encoding: 'utf-8',
          mode: 0o600,
        });
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
   * Save onboarding state to the app state root's settings.json
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

  private deriveCchBaseUrl(
    responseClaudeBaseUrl: string | undefined,
    fallbackServerUrl: string
  ): string {
    const baseUrl = responseClaudeBaseUrl?.trim() || fallbackServerUrl;
    return this.normalizeServerUrl(baseUrl).replace(/\/v1$/i, '');
  }

  /**
   * Verify that the CLI credential files still carry usable Anthropic/OpenAI
   * keys. We've seen a "settings.json contains only hooks" failure mode on
   * fresh machines that we cannot reproduce locally — the existing
   * detectCredentialFilesAvailable check only looks at file existence, so it
   * misses the case where the file exists but env got dropped. This deeper
   * check inspects actual content so the renderer can route back to
   * re-registration before the user hits "无法调用 API" inside the terminal.
   *
   * Logs to console (which the renderer's DevTools and the main log can both
   * capture) so we can post-mortem affected users without shipping a custom
   * diagnostic build.
   */
  checkCredentialsHealth(): OnboardingCredentialsHealth {
    let claudeEnvOk = false;
    let codexAuthOk = false;
    const reasons: string[] = [];

    try {
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (!fs.existsSync(claudeSettingsPath)) {
        reasons.push('claude:settings.json missing');
      } else {
        const settings = this.readJsonIfExists(claudeSettingsPath) as Record<string, unknown>;
        const env = this.readEnvRecord(settings.env);
        const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
        const authToken =
          typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : '';
        if (baseUrl && authToken) {
          claudeEnvOk = true;
        } else {
          const topKeys = Object.keys(settings).join(',') || '<empty>';
          reasons.push(
            `claude:env incomplete (baseUrl=${baseUrl ? 'set' : 'empty'}, authToken=${authToken ? 'set' : 'empty'}, topKeys=${topKeys})`
          );
        }
      }
    } catch (error) {
      reasons.push(`claude:check threw ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
      if (!fs.existsSync(codexAuthPath)) {
        reasons.push('codex:auth.json missing');
      } else {
        const auth = this.readJsonIfExists(codexAuthPath) as Record<string, unknown>;
        const apiKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : '';
        if (apiKey) {
          codexAuthOk = true;
        } else {
          reasons.push('codex:OPENAI_API_KEY empty');
        }
      }
    } catch (error) {
      reasons.push(`codex:check threw ${error instanceof Error ? error.message : String(error)}`);
    }

    const reason = reasons.length > 0 ? reasons.join('; ') : undefined;
    if (reason) {
      console.warn('[OnboardingService] credentials health degraded:', reason);
    }
    return { claudeEnvOk, codexAuthOk, reason };
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
