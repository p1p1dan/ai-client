import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PI_BORROW_RESOURCES_DIR_ENV,
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_MANAGED_AGENT_DIR_NAME,
  PI_MODEL_CONFIG_PATH,
  PI_MODEL_MANAGEMENT_URL_ENV,
  PI_MODEL_MANAGEMENT_URL_SETTING_KEY,
  PI_OPT_IN_EXTENSIONS_ENV,
  PI_PROJECT_TRUST_ENV,
  PI_SUBAGENTS_FEATURE_ID,
  type PiModelSyncResult,
  type PiModelSyncState,
  type PiResourceSettings,
} from '@shared/piModelConfig';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { net } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';
import { PiModelConfigService } from './PiModelConfigService';

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function getManagedPiAgentDir(): string {
  return join(getAppStateRoot(), PI_MANAGED_AGENT_DIR_NAME);
}

export function getManagedPiPromptTemplatesDir(): string {
  return join(getManagedPiAgentDir(), 'prompts');
}

export function getLocalPiAgentDir(): string {
  const inherited = process.env.PI_CODING_AGENT_DIR?.trim();
  return inherited || join(getHomeDir(), '.pi', 'agent');
}

/**
 * Where the catalog lives when nobody has typed an address (plan D05).
 *
 * The endpoint belongs to the onboarding service, so the default is that
 * service's own address — this build's compile-time constant — plus the
 * catalog path. Nothing is derived from the CCH gateway, and the old
 * `http://127.0.0.1:3210` default is gone: in a packaged build it could only
 * ever fail, and the failure used to be hidden behind a built-in model list.
 */
export function defaultPiModelManagementUrl(): string {
  return `${getOnboardingServiceUrl().trim().replace(/\/+$/, '')}${PI_MODEL_CONFIG_PATH}`;
}

export function getPiModelManagementUrl(): string {
  const envUrl = process.env[PI_MODEL_MANAGEMENT_URL_ENV]?.trim();
  if (envUrl) return envUrl;
  const stored = readSharedSettings()[PI_MODEL_MANAGEMENT_URL_SETTING_KEY];
  return typeof stored === 'string' && stored.trim()
    ? stored.trim()
    : defaultPiModelManagementUrl();
}

export function setPiModelManagementUrl(endpointUrl: string): string {
  const normalized = endpointUrl.trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Model management URL must use http or https');
  }
  const settings = readSharedSettings();
  writeSharedSettings({ ...settings, [PI_MODEL_MANAGEMENT_URL_SETTING_KEY]: normalized });
  return normalized;
}

function serviceFor(agentDir: string): PiModelConfigService {
  return new PiModelConfigService({
    agentDir,
    fetchFn: (url, init) => net.fetch(url, init),
    log: (...args) => console.info(...args),
  });
}

/**
 * The credentials a provider inherits when it does not carry its own: what this
 * client received at login. `pi` first (stated by the server since D06), then
 * the codex derivation older deployments leave us with.
 */
function managedCredential(): { apiKey: string; baseUrl: string } | null {
  const result = getCredentialVault().read();
  if (result.status !== 'ok') return null;
  const payload = result.doc.payload;
  const apiKey = payload.pi?.apiKey || payload.codex?.apiKey;
  const baseUrl = payload.pi?.baseUrl || payload.codex?.baseUrl || `${payload.cchBaseUrl}/v1`;
  return apiKey && baseUrl ? { apiKey, baseUrl } : null;
}

export async function syncManagedPiModels(
  endpointUrl = getPiModelManagementUrl(),
  options: { force?: boolean } = {}
): Promise<PiModelSyncResult> {
  const service = serviceFor(getManagedPiAgentDir());
  if (!resolveManagedCredentialsEnabled()) {
    const state = service.readState();
    return { ...state, ok: false, error: 'Managed credentials are disabled' };
  }
  const credential = managedCredential();
  if (!credential) {
    const state = service.readState();
    return { ...state, ok: false, error: 'Managed credentials are unavailable' };
  }
  return service.sync({
    endpointUrl,
    apiKey: credential.apiKey,
    inheritedBaseUrl: credential.baseUrl,
    force: options.force,
  });
}

export function getPiModelSyncState(): PiModelSyncState {
  const managed = resolveManagedCredentialsEnabled();
  const agentDir = managed ? getManagedPiAgentDir() : getLocalPiAgentDir();
  const service = serviceFor(agentDir);
  const state = service.readState();
  if (!managed) {
    const catalog = service.readCatalog('local');
    return {
      ...state,
      source: 'local',
      endpointUrl: null,
      modelCount: catalog.models.length,
      providerCount: new Set(catalog.models.map((model) => model.id.split('/', 1)[0])).size,
    };
  }
  return { ...state, endpointUrl: getPiModelManagementUrl() };
}

export function readPiModelCatalog(): AgentModelCatalog {
  const managed = resolveManagedCredentialsEnabled();
  const service = serviceFor(managed ? getManagedPiAgentDir() : getLocalPiAgentDir());
  return service.readCatalog(managed ? undefined : 'local');
}

export function clearManagedPiCredential(): void {
  serviceFor(getManagedPiAgentDir()).clearCredential();
}

/**
 * R01 — whether to lend the Host the user's own skills and prompt templates.
 *
 * Default ON. This feature exists for people who installed things where the
 * documentation told them to and got no indication that it had no effect;
 * defaulting it off would leave exactly those people in the dark. The borrowed
 * surface is text resources, never extensions.
 */
export function resolveBorrowUserPiResources(): boolean {
  const stored = readSharedSettings()[PI_BORROW_USER_RESOURCES_SETTING_KEY];
  return stored !== false;
}

export function getActivePiPromptTemplatesDir(): string {
  return resolveManagedCredentialsEnabled()
    ? getManagedPiPromptTemplatesDir()
    : join(getLocalPiAgentDir(), 'prompts');
}

/**
 * Whether the bundled sub-agent extension is injected. Default OFF, which is
 * the opposite default from {@link resolveBorrowUserPiResources}.
 *
 * The two switches differ because their silent failures differ. Borrowing is
 * default-on because someone who installed a skill the documented way would
 * otherwise get no indication it was ignored. Sub-agents are default-off
 * because the cost of the feature is paid by everyone on every turn — its three
 * tool schemas sit in the cached prefix of every request — while the feature is
 * used by a minority of sessions, and its absence is visible the moment the
 * model has no `subagent` tool to call.
 */
export function resolvePiSubagentsEnabled(): boolean {
  return readSharedSettings()[PI_ENABLE_SUBAGENTS_SETTING_KEY] === true;
}

export function getPiResourceSettings(): PiResourceSettings {
  const userAgentDir = getLocalPiAgentDir();
  const managedAgentDir = getManagedPiAgentDir();
  return {
    managed: resolveManagedCredentialsEnabled(),
    borrowUserPiResources: resolveBorrowUserPiResources(),
    enableSubagents: resolvePiSubagentsEnabled(),
    paths: {
      sharedSkills: join(getHomeDir(), '.agents', 'skills'),
      userSkills: join(userAgentDir, 'skills'),
      userPromptTemplates: join(userAgentDir, 'prompts'),
      managedSkills: join(managedAgentDir, 'skills'),
      managedPromptTemplates: getManagedPiPromptTemplatesDir(),
    },
  };
}

export function resolveManagedPiWorkerEnv(): Record<string, string> {
  const managed = resolveManagedCredentialsEnabled();
  // Only managed mode moved the agent dir away from the user's own; in local
  // mode the Host already loads that directory, so lending it again would list
  // every skill twice. The Host guards this too, but not sending it keeps the
  // env var honest about what it means.
  const borrowFrom = managed && resolveBorrowUserPiResources() ? getLocalPiAgentDir() : undefined;
  // Opt-in bundled extensions. Sent in BOTH modes — unlike the borrow
  // directory, this one is not a managed-mode repair, it is a cost the user
  // opted into, and the bundled copy is injected in local mode too.
  const optIn = resolvePiSubagentsEnabled() ? [PI_SUBAGENTS_FEATURE_ID] : [];
  return {
    // T08-c (D-Q9 decision 4). Sent in BOTH modes, never omitted: an absent key
    // identifies a legacy process build, not either deliberate trust posture.
    [PI_PROJECT_TRUST_ENV]: managed ? '0' : '1',
    ...(managed ? { PI_CODING_AGENT_DIR: getManagedPiAgentDir() } : {}),
    ...(borrowFrom ? { [PI_BORROW_RESOURCES_DIR_ENV]: borrowFrom } : {}),
    ...(optIn.length > 0 ? { [PI_OPT_IN_EXTENSIONS_ENV]: optIn.join(',') } : {}),
  };
}

export function resolveManagedPiPtyEnv(): Record<string, string> {
  // R01: the borrow directory is dropped here. It is read by OUR Host code, not
  // by pi, so the real pi CLI in the PTY would ignore it — and leaving it in the
  // environment would claim a borrow that is not happening. TUI sessions load
  // only what the agent dir gives them; closing that gap needs a pi-side
  // mechanism we do not have (Q-R4).
  const {
    [PI_BORROW_RESOURCES_DIR_ENV]: _borrowed,
    [PI_OPT_IN_EXTENSIONS_ENV]: _optIn,
    ...ptyEnv
  } = resolveManagedPiWorkerEnv();
  return ptyEnv;
}

export { validatePiManagedModelsConfig } from './configValidation';
export { PiModelConfigService } from './PiModelConfigService';
