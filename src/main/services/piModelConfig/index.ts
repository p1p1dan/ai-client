import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PI_MANAGED_AGENT_DIR_NAME,
  PI_MODEL_CONFIG_PATH,
  PI_MODEL_MANAGEMENT_URL_ENV,
  PI_MODEL_MANAGEMENT_URL_SETTING_KEY,
  PI_OPT_IN_EXTENSIONS_ENV,
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
import { optInFeatureRegistry } from '../../../agent-host/bundledPlugins.mjs';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';
import { readUserProviderGroupForRuntime, readUserProvidersForRuntime } from '../userProviders';
import { type NativeModelCatalog, resolveNativeModelCatalogWith } from './nativeCatalog';
import { resolveOptInFeatures } from './optInFeatures';
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
  return service.readCatalog(managed ? undefined : 'local');
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
 * Whether the bundled sub-agent extension is injected. Default OFF.
 *
 * Off by default because the cost of the feature is paid by everyone on every
 * turn — its three tool schemas sit in the cached prefix of every request —
 * while the feature is used by a minority of sessions, and its absence is
 * visible the moment the model has no `subagent` tool to call.
 */
export function resolvePiSubagentsEnabled(): boolean {
  return resolveOptInFeatures(readSharedSettings()).includes(PI_SUBAGENTS_FEATURE_ID);
}

export function getPiResourceSettings(): PiResourceSettings {
  const userAgentDir = getLocalPiAgentDir();
  const appAgentDir = getAppPiAgentDir();
  const enabledFeatures = new Set(resolveOptInFeatures(readSharedSettings()));
  return {
    managed: resolveManagedCredentialsEnabled(),
    enableSubagents: enabledFeatures.has(PI_SUBAGENTS_FEATURE_ID),
    paths: {
      sharedSkills: join(getHomeDir(), '.agents', 'skills'),
      userSkills: join(userAgentDir, 'skills'),
      userPromptTemplates: join(userAgentDir, 'prompts'),
      appSkills: join(appAgentDir, 'skills'),
      appPromptTemplates: getAppPiPromptTemplatesDir(),
    },
    bundledFeatures: optInFeatureRegistry().map(({ legacySettingKey: _legacy, ...feature }) => ({
      ...feature,
      enabled: enabledFeatures.has(feature.id),
    })),
  };
}

export function resolveManagedPiWorkerEnv(): Record<string, string> {
  const managed = resolveManagedCredentialsEnabled();
  // Opt-in bundled extensions. Sent in BOTH modes: this is a cost the user
  // opted into, and the bundled copy is injected in local mode too.
  const optIn = resolveOptInFeatures(readSharedSettings());
  return {
    // T08-c (D-Q9 decision 4). Sent in BOTH modes, never omitted: an absent key
    // identifies a legacy process build, not either deliberate trust posture.
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
    ...(optIn.length > 0 ? { [PI_OPT_IN_EXTENSIONS_ENV]: optIn.join(',') } : {}),
  };
}

export function resolveManagedPiPtyEnv(): Record<string, string> {
  // The opt-in extension list is dropped here: it is read by OUR Host code, not
  // by pi, so the real pi CLI in the PTY would ignore it — and leaving it in the
  // environment would claim an injection that is not happening. A TUI session
  // loads what the agent dir's own `settings.json` gives it, which since H/19 is
  // the same file the GUI session reads.
  //
  // `PI_CODING_AGENT_DIR` and F08's User-Agent are deliberately NOT dropped:
  // they are the opposite kind of variable. pi itself resolves both, so a PTY
  // turn lands in the same directory and identifies itself the same way a worker
  // turn does.
  const { [PI_OPT_IN_EXTENSIONS_ENV]: _optIn, ...ptyEnv } = resolveManagedPiWorkerEnv();
  return ptyEnv;
}

export { validatePiManagedModelsConfig } from './configValidation';
export { PiModelConfigService } from './PiModelConfigService';
