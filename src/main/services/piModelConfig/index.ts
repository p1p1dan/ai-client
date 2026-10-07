import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyDshPlanToCatalog, type DshModelPlan } from '@shared/dshModelPlan';
import {
  MANAGED_CREDENTIALS_DISABLED_ERROR,
  MANAGED_CREDENTIALS_UNAVAILABLE_ERROR,
  PI_MANAGED_AGENT_DIR_NAME,
  PI_MODEL_CONFIG_PATH,
  PI_MODEL_MANAGEMENT_URL_ENV,
  PI_MODEL_MANAGEMENT_URL_SETTING_KEY,
  type PiModelSyncFailure,
  type PiModelSyncFailureKind,
  type PiModelSyncResult,
  type PiModelSyncState,
  type PiResourceSettings,
} from '@shared/piModelConfig';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { app, net } from 'electron';
import { promptCacheTtlSettings } from '../agent-host/promptCacheSettings';
import { providerTimeoutSettings } from '../agent-host/providerTimeoutSettings';
import { getAppStateRoot } from '../appStatePaths';
import { getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';
import { readUserProviderGroupForRuntime, readUserProvidersForRuntime } from '../userProviders';
import { resolveDshModelPlanWith } from './dshModelPlan';
import type { ManagedKeyStore } from './managedKeys';
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

/**
 * dsh-rebase P1-5e (decisions 149, 152) — the administrator keys of the
 * managed catalog live in the credential vault, in their own group, with the
 * same protection as the login key: encrypted where the platform can, 0600
 * otherwise. Unreadable (locked keyring, damaged file) reads as `null`, and the
 * providers needing those keys are left out until it reads again.
 */
const vaultManagedKeyStore: ManagedKeyStore = {
  read: () => {
    const result = getCredentialVault().readManagedProviderKeys();
    return result.status === 'ok' ? result.keys : null;
  },
  replace: async (keys) => (await getCredentialVault().saveManagedProviderKeys(keys)).ok,
};

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
    managedKeyStore: vaultManagedKeyStore,
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
 * Rewrite `models.json` so it matches the stored user services (no key file
 * since P1-11, decision 127).
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
 * dsh-rebase P1-5a — the model plan the DSH host is configured with (decision
 * 033): routes without keys, the default model, and the index the menu and the
 * bridge resolve against. Built from the same in-memory catalog as the menu.
 */
export function resolveDshModelPlan(): DshModelPlan {
  return dshModelPlanFor(resolveNativeModelCatalog());
}

function dshModelPlanFor(native: NativeModelCatalog | undefined): DshModelPlan {
  const { promptCacheTtl } = promptCacheTtlSettings();
  return resolveDshModelPlanWith({
    native,
    env: process.env,
    settings: { ...(promptCacheTtl ? { promptCacheTtl } : {}), ...providerTimeoutSettings() },
    clientVersion: app.getVersion(),
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

/**
 * The last managed sync that came away with NO catalog.
 *
 * Why this is remembered at all: the login-time sync
 * (`ipc/onboarding.ts`'s `onSuccess`) and the startup one
 * (`managedCredentialsStartup.regenerateFromVault`) both run with no renderer
 * waiting on their result, so their outcome used to exist only as a
 * `console.warn` — a user signed in, landed on an empty model menu, and was
 * told nothing. This is the value that lets the window ask afterwards.
 *
 * In memory rather than on disk, deliberately. `managed-models-state.json`
 * describes the CATALOG (what is on disk, where it came from, when), and the
 * two credential refusals below never touch a catalog — writing them there
 * would put an error on a state file that is otherwise a true description of
 * `models.json`, and the settings page would report it as a catalog fault
 * forever. The lifetime that is actually wanted is "until the next attempt",
 * and every app start makes one on the managed route, so nothing is lost
 * across a restart that the restart itself does not immediately re-establish.
 */
let lastManagedSyncFailure: PiModelSyncFailure | null = null;

/** What the last managed sync failed on, or `null` when it worked. */
export function getManagedPiSyncFailure(): PiModelSyncFailure | null {
  return lastManagedSyncFailure;
}

/**
 * Failures that are about the ACCOUNT rather than the wire.
 *
 * These are remembered even when the sync came away with a catalog, and that
 * exception is the point. A 401 from the management endpoint falls through to
 * the shipped baseline (`sync`'s A3 rung), which returns `ok: true` and writes
 * that baseline's providers with the very key the endpoint just refused — so
 * the user gets a full model menu in which every turn fails at request time.
 * A populated menu is not a rescue when the account cannot use it, and staying
 * quiet there would reproduce the silence this whole notice exists to end.
 *
 * A transient wire failure is the opposite case and is deliberately NOT here:
 * the baseline is a real catalog the account CAN use, the model menu already
 * says the list is the shipped one, and a red card over a working app is the
 * permanently-lit box `chatEmptyState.ts` was written to get rid of.
 */
const ACCOUNT_SYNC_FAILURES: ReadonlySet<PiModelSyncFailureKind> = new Set([
  'unauthorized',
  'credentials-missing',
  'credentials-disabled',
]);

function rememberSyncOutcome(result: PiModelSyncResult): PiModelSyncResult {
  const kind = result.failureKind;
  const worthReporting = kind !== undefined && (!result.ok || ACCOUNT_SYNC_FAILURES.has(kind));
  lastManagedSyncFailure = worthReporting
    ? { kind, error: result.error ?? '', at: Date.now() }
    : null;
  return result;
}

export async function syncManagedPiModels(
  endpointUrl = getPiModelManagementUrl(),
  options: { force?: boolean } = {}
): Promise<PiModelSyncResult> {
  const service = serviceFor(getAppPiAgentDir());
  if (!resolveManagedCredentialsEnabled()) {
    const state = service.readState();
    return rememberSyncOutcome({
      ...state,
      ok: false,
      error: MANAGED_CREDENTIALS_DISABLED_ERROR,
      failureKind: 'credentials-disabled',
    });
  }
  const credential = managedCredential();
  if (!credential) {
    const state = service.readState();
    return rememberSyncOutcome({
      ...state,
      ok: false,
      error: MANAGED_CREDENTIALS_UNAVAILABLE_ERROR,
      failureKind: 'credentials-missing',
    });
  }
  const outcome = rememberSyncOutcome(
    await service.sync({
      endpointUrl,
      apiKey: credential.apiKey,
      inheritedBaseUrl: credential.baseUrl,
      force: options.force,
    })
  );
  // dsh-rebase decision 033 rule 4: a sync that finished after the host
  // started leaves it on an older plan; rebuilding announces the new one.
  if (outcome.ok) {
    try {
      resolveDshModelPlan();
    } catch (error) {
      console.warn('[pi-models] the DSH model plan could not be rebuilt after a sync', error);
    }
  }
  return outcome;
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
  //
  // dsh-rebase P1-5a (decision 033): the menu then keeps only what the DSH
  // model plan routes, and the plan is built from this SAME assembly, so a
  // listed model is one the host can serve, with the efforts it accepts.
  const native = resolveNativeModelCatalog();
  const menu = service.readCatalog(managed ? undefined : 'local', native);
  return applyDshPlanToCatalog(menu, dshModelPlanFor(native));
}

export function clearManagedPiCredential(): void {
  serviceFor(getAppPiAgentDir()).clearCredential();
}

/**
 * Settings → Extensions → Skills: the two skill folders the DSH host reads
 * (dsh-rebase P1-16e, decision 101). The delegation switch, the prompt
 * template folders and the user's own `~/.pi/agent` folders left with
 * decisions 103-105 and 116; P1-12 step 1 removed them from this reply.
 */
export function getPiResourceSettings(): PiResourceSettings {
  return {
    managed: resolveManagedCredentialsEnabled(),
    paths: {
      sharedSkills: join(getHomeDir(), '.agents', 'skills'),
      appSkills: join(getAppPiAgentDir(), 'skills'),
    },
  };
}

export { validatePiManagedModelsConfig } from './configValidation';
export { onDshModelPlanBuilt } from './dshModelPlan';
export { PiModelConfigService } from './PiModelConfigService';
