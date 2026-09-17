import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PI_MANAGED_AGENT_DIR_NAME,
  PI_MODEL_CONFIG_PATH,
  PI_MODEL_MANAGEMENT_URL_ENV,
  PI_MODEL_MANAGEMENT_URL_SETTING_KEY,
  PI_PROJECT_TRUST_ENV,
  PI_SUBAGENTS_FEATURE_ID,
  PI_USER_AGENT_ENV,
  type PiModelSyncResult,
  type PiModelSyncState,
  type PiResourceSettings,
  piUserAgent,
} from '@shared/piModelConfig';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { app, net } from 'electron';
import { nativeFeatureRegistry } from '../../../agent-host/bundledPlugins.mjs';
import { nativeSubagentSettings } from '../agent-host/nativeSubagentSettings';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';
import { readUserProviderGroupForRuntime, readUserProvidersForRuntime } from '../userProviders';
import { type NativeModelCatalog, resolveNativeModelCatalogWith } from './nativeCatalog';
import { PiModelConfigService } from './PiModelConfigService';

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * The agent directory this app owns, under its own profile root.
 *
 * H/19 renamed this from `getManagedPiAgentDir`: it is no longer the managed
 * route's directory, it is the ONE directory every session runs out of. The
 * old name would now read as a claim that the local route uses something else.
 */
export function getAppPiAgentDir(): string {
  return join(getAppStateRoot(), PI_MANAGED_AGENT_DIR_NAME);
}

export function getAppPiPromptTemplatesDir(): string {
  return join(getAppPiAgentDir(), 'prompts');
}

/**
 * The user's OWN pi directory — read-only from here, and no longer loaded.
 *
 * It survives H/19 as the migration SOURCE (and as the place the permission
 * policy page reads a local-route policy from), never as a destination. See
 * `services/agentMigration` for what gets copied out of it.
 */
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
    // H/17: supplied to EVERY service instance, so a managed sync rebuilding
    // `models.json` from the server response cannot drop the user's services.
    userProviders: readUserProvidersForRuntime,
    // import-catalog-03: supplied to EVERY instance for the same reason. The
    // "do not lend the shipped baseline to a local installation" rule belongs
    // to the catalog, so it has to be answerable wherever the catalog is built
    // — not only in the one reader that used to be handed a `'local'` override.
    managedCredentialsEnabled: resolveManagedCredentialsEnabled,
  });
}

/**
 * The agent directory pi is pointed at — the same one in BOTH modes (H/19).
 *
 * H/17 made this conditional: the local route moved here only once the user had
 * added a service of their own. That branch was the defect. A directory that
 * moves when an unrelated setting changes takes the model catalogue, the
 * credentials and the session history with it, silently, and every repair for
 * one of those had to be written twice — once for each side of the branch.
 * There is now one answer.
 */
export function getActivePiAgentDir(): string {
  return getAppPiAgentDir();
}

/**
 * Rewrite the two files pi reads so they match the stored user services.
 *
 * Called after any change to the user group. The other half of the file comes
 * from `managedHalf()` — the same function the in-memory hand-over uses, so a
 * user edit cannot make the file disagree with what a native worker is running
 * on (import-catalog-03). On the local route with nothing ever fetched there is
 * no other half, and the file holds user services alone.
 */
export function writeUserProviderRuntimeConfig(): void {
  const credential = managedCredential();
  try {
    serviceFor(getAppPiAgentDir()).writeUserProviderConfig({
      userProviders: readUserProvidersForRuntime(),
      inheritedApiKey: credential?.apiKey ?? '',
      inheritedBaseUrl: credential?.baseUrl ?? '',
    });
  } catch (error) {
    console.warn('[pi-models] failed to write user provider config', error);
  }
}

/**
 * P5-5 — the model catalog to hand a native worker, assembled in memory.
 *
 * The rule lives in `nativeCatalog.ts`; this is only the wiring that reads the
 * four real inputs it needs. See that module for why the split exists and what
 * `undefined` means.
 */
export function resolveNativeModelCatalog(): NativeModelCatalog | undefined {
  return resolveNativeModelCatalogWith({
    managedCredentialsEnabled: resolveManagedCredentialsEnabled,
    managedCredential,
    readUserProviderGroup: readUserProviderGroupForRuntime,
    buildCatalog: (input) => serviceFor(getAppPiAgentDir()).buildNativeModelCatalog(input),
    warn: (...args) => console.warn(...args),
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
  const service = serviceFor(getAppPiAgentDir());
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
  const service = serviceFor(getActivePiAgentDir());
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
  const service = serviceFor(getActivePiAgentDir());
  // The `'local'` source label follows the credential mode, not the directory:
  // a local-route catalog is still the user's own even once it is assembled in
  // our directory, and relabelling it 'remote' would claim a sync happened.
  //
  // T062 / D3 — the menu is built from the SAME document a worker gets. The
  // two used to be different things: this read went to `models.json` on disk
  // while `WorkerManager` handed the worker the in-memory assembly, so any
  // provider that existed only in the file was listed here and unknown there.
  // `undefined` is passed straight through: that is exactly the case where the
  // worker falls back to reading the directory (`nativeCatalog.ts`), so the
  // file is the right answer for both sides then.
  return service.readCatalog(managed ? undefined : 'local', resolveNativeModelCatalog());
}

export function clearManagedPiCredential(): void {
  serviceFor(getAppPiAgentDir()).clearCredential();
}

/**
 * Where "open my prompt templates" lands.
 *
 * H/19: the app directory in both modes, because that is the only directory a
 * session loads templates from now. Opening `~/.pi/agent/prompts` would show a
 * folder whose contents no longer reach any turn.
 */
export function getActivePiPromptTemplatesDir(): string {
  return getAppPiPromptTemplatesDir();
}

/**
 * The settings page's view of the native feature switches.
 *
 * cutover-10: `enabled` comes from `nativeSubagentSettings`, which is the same
 * function `WorkerManager` asks before it builds a graph. The page used to
 * answer from a separate resolver whose "nobody chose" was OFF while the
 * runtime's was ON, so a fresh install saw a switch that said the opposite of
 * what every turn was doing.
 */
function nativeFeatureEnabled(id: string): boolean {
  // One switch, one reader. A second feature added here needs its own reader
  // rather than a default parked in the registry — that split is what produced
  // cutover-10.
  return id === PI_SUBAGENTS_FEATURE_ID ? nativeSubagentSettings().enabled : false;
}

export function getPiResourceSettings(): PiResourceSettings {
  const userAgentDir = getLocalPiAgentDir();
  const appAgentDir = getAppPiAgentDir();
  return {
    managed: resolveManagedCredentialsEnabled(),
    enableSubagents: nativeFeatureEnabled(PI_SUBAGENTS_FEATURE_ID),
    paths: {
      sharedSkills: join(getHomeDir(), '.agents', 'skills'),
      userSkills: join(userAgentDir, 'skills'),
      userPromptTemplates: join(userAgentDir, 'prompts'),
      appSkills: join(appAgentDir, 'skills'),
      appPromptTemplates: getAppPiPromptTemplatesDir(),
    },
    features: nativeFeatureRegistry().map(({ legacySettingKey: _legacy, ...feature }) => ({
      ...feature,
      enabled: nativeFeatureEnabled(feature.id),
    })),
  };
}

export function resolveManagedPiWorkerEnv(): Record<string, string> {
  const managed = resolveManagedCredentialsEnabled();
  return {
    // T08-c (D-Q9 decision 4). Sent in BOTH modes, never omitted: an absent key
    // identifies a legacy process build, not either deliberate trust posture.
    // decision 009 — this is the MANAGED-ROUTE MARKER, not the native worker's
    // project trust any more. The native answer is the `NATIVE_PROJECT_TRUSTED`
    // constant the worker entry reads, so a managed session loads a project's
    // MCP servers, skills, permission policy and instruction files exactly as a
    // local one does. What still reads this key is `PiTuiPty`, which strips
    // inherited credential variables out of a managed PTY.
    [PI_PROJECT_TRUST_ENV]: managed ? '0' : '1',
    // F08. Sent in BOTH modes for the same reason as the trust flag, and read
    // from `app` rather than from `package.json` because the packaged app's
    // version is the one the gateway should see. The `models.json` this app
    // writes references the variable by name; supplying it here is what makes
    // that reference resolve to something other than an empty header.
    [PI_USER_AGENT_ENV]: piUserAgent(app.getVersion()),
    // H/19: unconditional. Both modes run out of this app's directory, so there
    // is no longer a case where pi should be left on its own default.
    PI_CODING_AGENT_DIR: getAppPiAgentDir(),
  };
}

/**
 * What the real pi CLI in a PTY is handed.
 *
 * cutover-10 emptied the difference: the only key this used to drop was the
 * opt-in extension list, which was read by OUR Host code and would have claimed
 * an injection the CLI never performed. That list is gone, so a TUI now gets
 * exactly what a worker gets.
 *
 * Kept as its own name rather than collapsed into the caller, because the three
 * keys left are ALL ones pi itself resolves — `PI_CODING_AGENT_DIR` puts the TUI
 * in the same directory as the GUI (U3), F08's User-Agent makes the header the
 * gateway sees correct, and the managed marker is what `PiTuiPty` reads before
 * it strips inherited credentials. The next worker-only variable needs a place
 * to be dropped, and this is that place.
 */
export function resolveManagedPiPtyEnv(): Record<string, string> {
  return { ...resolveManagedPiWorkerEnv() };
}

export { validatePiManagedModelsConfig } from './configValidation';
export { PiModelConfigService } from './PiModelConfigService';
