import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PI_MANAGED_AGENT_DIR_NAME,
  PI_MODEL_CONFIG_PATH,
  PI_MODEL_MANAGEMENT_URL_ENV,
  PI_MODEL_MANAGEMENT_URL_SETTING_KEY,
  PI_PROJECT_TRUST_ENV,
  type PiModelSyncResult,
  type PiModelSyncState,
} from '@shared/piModelConfig';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { net } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';
import { PiModelConfigService } from './PiModelConfigService';

export function getManagedPiAgentDir(): string {
  return join(getAppStateRoot(), PI_MANAGED_AGENT_DIR_NAME);
}

export function getLocalPiAgentDir(): string {
  const inherited = process.env.PI_CODING_AGENT_DIR?.trim();
  return (
    inherited || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.pi', 'agent')
  );
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

export function resolveManagedPiWorkerEnv(): Record<string, string> {
  const managed = resolveManagedCredentialsEnabled();
  return {
    // T08-c (D-Q9 decision 4). Sent in BOTH modes, never omitted: an absent key
    // identifies a legacy process build, not either deliberate trust posture.
    [PI_PROJECT_TRUST_ENV]: managed ? '0' : '1',
    ...(managed ? { PI_CODING_AGENT_DIR: getManagedPiAgentDir() } : {}),
  };
}

export function resolveManagedPiPtyEnv(): Record<string, string> {
  return resolveManagedPiWorkerEnv();
}

export { validatePiManagedModelsConfig } from './configValidation';
export { PiModelConfigService } from './PiModelConfigService';
