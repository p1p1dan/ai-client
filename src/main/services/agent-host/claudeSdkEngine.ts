import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type ChatEngine,
  CLAUDE_SDK_AUTO_COMPACT_PERCENT_ENV,
  CLAUDE_SDK_DROP_EMPTY_SYSTEM_ENV,
  CLAUDE_SDK_INHERITED_ENV,
  CLAUDE_SDK_MODEL_WINDOWS_ENV,
  CLAUDE_SDK_STUB_SUFFIX,
  type ClaudeSdkRoute,
  claudeSdkRouteFor,
  effectiveModelRef,
} from '@shared/claudeSdkEngine';
import type { DshModelPlan } from '@shared/dshModelPlan/types';
import { app } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { getEngineProxySetting, onEngineProxyChange } from '../proxy/ProxyConfig';
import { ClaudeSdkProcessTransport } from './ClaudeSdkProcessTransport';
import { claudeSdkAutoCompactPercent, claudeSdkDropEmptySystem } from './claudeSdkEngineSetting';
import { ensurePrivateDirectory, resolveDshHostLayout } from './DshHostProcess';
import type { WorkerTransport } from './WorkerTransport';
import { WorkerManagerError } from './workerManagerError';

/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md):
 * which chats run on the Claude Agent SDK engine, and how that engine's
 * per-chat host is launched. The only place engine selection lives.
 *
 * The engine is fixed per chat:
 * - a NEW chat runs on it when the settings switch is on, its model (or, for
 *   "automatic", the plan's first model) is on an `anthropic-messages`
 *   route (`claudeSdkRouteFor`; the protocol alone decides, user ruling
 *   2026-10-16), and this build has the host; the resolved model is handed to
 *   the host explicitly. A host that still fails to start sends the new chat
 *   to DSH (`WorkerManager.createSession`);
 * - a REOPENED chat runs on the engine that created it, read off its session
 *   file ({@link CLAUDE_SDK_STUB_SUFFIX}), whatever the switch says now.
 *
 * The gateway address comes from the model plan Main last built and the key
 * from the credential broker's in-memory catalog, by provider id. Both reach
 * the host process through its launch environment only; nothing is written to
 * disk and the key is never logged.
 */

/** `WorkerManagerError` code: no route or key for an SDK chat at create or reopen. */
export const CLAUDE_SDK_CREDENTIALS_UNAVAILABLE = 'claude_sdk_credentials_unavailable';
/** `WorkerManagerError` code: the SDK host could not be started. */
export const CLAUDE_SDK_HOST_UNAVAILABLE = 'claude_sdk_host_unavailable';

/** `CLAUDE_CONFIG_DIR` of every SDK chat, under the app state root. */
export const CLAUDE_SDK_HOME_DIR_NAME = 'claude';

export type ClaudeSdkPlanView = Pick<DshModelPlan, 'index' | 'routes' | 'refs'>;

/**
 * What `WorkerManager` needs to run SDK chats, injected so it never imports
 * the catalog, the settings store or Electron itself (`dshHostModelSource.ts`
 * supplies the real one).
 */
export interface ClaudeSdkEngineSource {
  /** The settings switch, read when a chat is created. */
  enabled(): boolean;
  /** The plan Main built last (built once if none was); null when there is none. */
  plan(): ClaudeSdkPlanView | null;
  /** One provider's key from the in-memory catalog; undefined when it has none. */
  key(providerId: string): string | undefined;
  /** This build can start the SDK host. */
  hostAvailable(): boolean;
}

export type NewChatEngine =
  | { engine: 'dsh' }
  | {
      engine: 'claude-sdk';
      /** The explicit `provider/modelId` the host is started on. */
      model: string;
      route: ClaudeSdkRoute;
    };

const DSH: NewChatEngine = { engine: 'dsh' };

/** The source's plan; a plan that cannot be had reads as none. */
export function readClaudeSdkPlan(
  source: Pick<ClaudeSdkEngineSource, 'plan'>
): ClaudeSdkPlanView | null {
  try {
    return source.plan();
  } catch {
    // No plan (signed out, keyring locked): DSH's own failure path applies.
    return null;
  }
}

/**
 * The engine of a NEW chat (decision 1). Reads lazily: the plan only when the
 * switch is on, host availability only for a model the SDK would serve.
 */
export function chooseNewChatEngine(
  model: string | undefined,
  source: Pick<ClaudeSdkEngineSource, 'enabled' | 'plan' | 'hostAvailable'> | null
): NewChatEngine {
  if (!source?.enabled()) return DSH;
  const plan = readClaudeSdkPlan(source);
  if (!plan) return DSH;
  const ref = effectiveModelRef(plan, model);
  const route = claudeSdkRouteFor(plan, ref);
  if (!ref || !route) return DSH;
  if (!source.hostAvailable()) return DSH;
  return { engine: 'claude-sdk', model: ref, route };
}

export function engineForSessionFile(sessionFile: string | null | undefined): ChatEngine {
  return sessionFile?.endsWith(CLAUDE_SDK_STUB_SUFFIX) ? 'claude-sdk' : 'dsh';
}

/** The model a session stub records (`model`, our `provider/modelId`); older stubs have none. */
export function claudeSdkStubModel(stub: unknown): string | undefined {
  if (!stub || typeof stub !== 'object') return undefined;
  const model = (stub as { model?: unknown }).model;
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
}

/** A model the SDK engine serves, and where. */
export interface ClaudeSdkLaunch {
  model: string;
  route: ClaudeSdkRoute;
}

/**
 * The first of `candidates` the SDK engine serves, else the plan's first model
 * it serves; none is `claude_sdk_credentials_unavailable`.
 */
export function claudeSdkLaunchFor(
  plan: ClaudeSdkPlanView | null,
  candidates: ReadonlyArray<string | undefined>
): ClaudeSdkLaunch {
  if (plan) {
    for (const ref of [...candidates, ...Object.keys(plan.index)]) {
      const route = ref ? claudeSdkRouteFor(plan, ref) : null;
      if (ref && route) return { model: ref, route };
    }
  }
  throw new WorkerManagerError(
    CLAUDE_SDK_CREDENTIALS_UNAVAILABLE,
    'No model in the current model plan can run this chat on the Claude Agent SDK engine',
    true
  );
}

/**
 * The model a REOPENED SDK chat starts on (decision 2): `preferred` (the
 * request's model) when the SDK serves it, then the model its stub records,
 * then `fallback`, then the plan's first SDK model. A missing, unreadable or
 * older stub only skips its step.
 */
export async function resolveClaudeSdkLaunch(input: {
  plan: ClaudeSdkPlanView | null;
  sessionFile: string;
  readStub: (file: string) => Promise<unknown>;
  preferred?: string;
  fallback?: string;
}): Promise<ClaudeSdkLaunch> {
  const { plan } = input;
  const preferred = plan && input.preferred ? claudeSdkRouteFor(plan, input.preferred) : null;
  if (preferred && input.preferred) return { model: input.preferred, route: preferred };
  let stubModel: string | undefined;
  try {
    stubModel = claudeSdkStubModel(await input.readStub(input.sessionFile));
  } catch {
    stubModel = undefined;
  }
  return claudeSdkLaunchFor(plan, [stubModel, input.fallback]);
}

/** A route of the plan the SDK engine can reach, by its name; null otherwise. */
export function claudeSdkRouteByName(
  plan: ClaudeSdkPlanView,
  routeName: string
): Omit<ClaudeSdkRoute, 'model'> | null {
  const route = Object.hasOwn(plan.routes, routeName) ? plan.routes[routeName] : undefined;
  if (!route || route.api !== 'anthropic-messages' || !route.baseURL) return null;
  const providerId = Object.hasOwn(plan.refs, route.apiKeyEnv) ? plan.refs[route.apiKeyEnv] : '';
  return providerId ? { route: routeName, providerId, baseURL: route.baseURL } : null;
}

/**
 * What a running SDK chat was started against (decision 4): route, address
 * and a hash prefix of the key. Never the key itself.
 */
export function claudeSdkGatewayFingerprint(
  gateway: { route: string; baseURL: string },
  apiKey: string
): string {
  const keyHash = createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
  return `${gateway.route}|${gateway.baseURL}|${keyHash}`;
}

/** The fingerprint `routeName` would get now; null when its route or key is gone. */
export function currentClaudeSdkFingerprint(
  source: Pick<ClaudeSdkEngineSource, 'plan' | 'key'>,
  routeName: string
): string | null {
  const plan = readClaudeSdkPlan(source);
  const gateway = plan ? claudeSdkRouteByName(plan, routeName) : null;
  const key = gateway ? source.key(gateway.providerId) : undefined;
  return gateway && key ? claudeSdkGatewayFingerprint(gateway, key) : null;
}

/**
 * Where the SDK host lives (route B S-4 B-1): its source in a checkout, the
 * artifact afterPack copies (scripts/build-claude-sdk-host.mjs) when packaged.
 */
export const CLAUDE_SDK_HOST_LAYOUT = {
  unpackaged: ['src', 'claude-sdk-host', 'host.ts'],
  packaged: ['claude-sdk-host', 'host.js'],
} as const;

/**
 * The setting sources a host gets unless a dev override says otherwise: this app's
 * config dir as the user layer (ruling 19), the project and local settings (S-3 P-1).
 */
const DEFAULT_SETTING_SOURCES = 'user,project,local';

export interface ClaudeSdkHostLayoutInput {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Read only when unpackaged (S-4 B-5). */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeSdkHostLayout {
  entry: string;
  /** The SDK's package.json beside the entry. */
  sdk: string;
  /** Where the CLI binary may be, in order; the first that exists is the one (S-4 B-4). */
  cliCandidates: string[];
}

export function claudeSdkHostLayout(input: ClaudeSdkHostLayoutInput): ClaudeSdkHostLayout {
  const root = input.isPackaged ? input.resourcesPath : input.appPath;
  const entry = path.join(
    root,
    ...(input.isPackaged ? CLAUDE_SDK_HOST_LAYOUT.packaged : CLAUDE_SDK_HOST_LAYOUT.unpackaged)
  );
  const modules = path.join(path.dirname(entry), 'node_modules', '@anthropic-ai');
  return {
    entry,
    sdk: path.join(modules, 'claude-agent-sdk', 'package.json'),
    cliCandidates: claudeSdkCliCandidates(
      modules,
      input.platform ?? process.platform,
      input.arch ?? process.arch,
      // S-4 B-5: a packaged build runs its own CLI, whatever the environment says.
      input.isPackaged ? {} : (input.env ?? process.env)
    ),
  };
}

/**
 * S-4 B-4 (#31): the one CLI binary Main checks and hands to the host, which
 * gives it to the SDK as `pathToClaudeCodeExecutable`; undefined when none exists.
 */
export function claudeSdkCliPath(
  layout: ClaudeSdkHostLayout,
  exists: (file: string) => boolean = existsSync
): string | undefined {
  return layout.cliCandidates.find((file) => exists(file));
}

/**
 * S-4 B-5 (#27): the dev-only knobs, read from Main's environment only in an
 * unpackaged checkout. A packaged build reads the default sources and uses the
 * CLI's built-in `rg`.
 */
export function claudeSdkHostDevSettings(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv
): { settingSources: string; rgDir?: string } {
  if (isPackaged) return { settingSources: DEFAULT_SETTING_SOURCES };
  const rgDir = env.AICLIENT_CLAUDE_SDK_RG_DIR?.trim();
  return {
    settingSources: env.AICLIENT_CLAUDE_SDK_SETTING_SOURCES?.trim() ?? DEFAULT_SETTING_SOURCES,
    ...(rgDir ? { rgDir } : {}),
  };
}

/**
 * Where the CLI binary may be: the dev override (`AICLIENT_CLAUDE_SDK_CLI`, an
 * unpackaged checkout only, see `claudeSdkHostLayout`), else the SDK's platform
 * package for this OS and CPU (Linux also has a musl build; packaged builds
 * carry the glibc one only, S-4 B-3).
 */
export function claudeSdkCliCandidates(
  modules: string,
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv
): string[] {
  // Absolute, so the file Main checks is the one the SDK starts from the chat's cwd.
  const override = env.AICLIENT_CLAUDE_SDK_CLI?.trim();
  if (override) return [path.resolve(override)];
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';
  const base = `claude-agent-sdk-${platform}-${arch}`;
  const packages = platform === 'linux' ? [base, `${base}-musl`] : [base];
  return packages.map((name) => path.join(modules, name, binary));
}

/**
 * Can this build start the SDK host: its entry, its SDK package and the CLI
 * binary Main would hand it (S-4 B-4) are on disk. A build without them runs
 * every new chat on DSH, and says so once in the log.
 */
export function createClaudeSdkHostAvailability(deps: {
  appPath: () => string;
  isPackaged?: () => boolean;
  resourcesPath?: () => string;
  exists?: (file: string) => boolean;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}): () => boolean {
  const exists = deps.exists ?? existsSync;
  let logged = false;
  return () => {
    let missing: string | undefined;
    try {
      const layout = claudeSdkHostLayout({
        isPackaged: deps.isPackaged?.() ?? false,
        appPath: deps.appPath(),
        resourcesPath: deps.resourcesPath?.() ?? '',
        platform: deps.platform ?? process.platform,
        arch: deps.arch ?? process.arch,
        env: deps.env ?? process.env,
      });
      missing = [layout.entry, layout.sdk].find((file) => !exists(file));
      // The CLI binary too (user ruling 2026-10-16: a host that cannot start sends
      // a new chat to DSH), so a missing one is found here rather than at the first turn.
      if (missing === undefined && claudeSdkCliPath(layout, exists) === undefined) {
        missing = layout.cliCandidates.join(' | ');
      }
    } catch (error) {
      missing = error instanceof Error ? error.message : String(error);
    }
    if (missing === undefined) return true;
    if (!logged) {
      logged = true;
      deps.log?.(
        `[claude-sdk] this build has no Claude Agent SDK host (${missing}); new chats run on DSH`
      );
    }
    return false;
  };
}

/** Names the host may inherit from Main besides its own launch variables. */
const HOST_INHERITED = new Set([...CLAUDE_SDK_INHERITED_ENV, 'AICLIENT_GIT_BASH_PATH']);

export interface ClaudeSdkTransportInput {
  generation: number;
  cwd: string;
  /** The route's gateway root (`ClaudeSdkRoute.baseURL`). */
  baseURL: string;
  /** The route's key, held in memory for this launch only. */
  apiKey: string;
  /** The catalog's windows for the route's models (`claudeSdkModelWindows`); empty or absent: none. */
  modelWindows?: Record<string, number>;
}

/**
 * Start one SDK host for one chat. Runs on the same Node the DSH host runs on
 * (`resolveDshHostLayout`, so `AICLIENT_DSH_NODE` applies in dev), from
 * `src/claude-sdk-host/host.ts` in a checkout and `resources/claude-sdk-host/host.js`
 * when packaged (S-4).
 */
export function openClaudeSdkTransport(input: ClaudeSdkTransportInput): WorkerTransport {
  if (!existsSync(input.cwd)) {
    throw new Error(`WORKER_WORKSPACE_MISSING: session working directory is missing: ${input.cwd}`);
  }
  const baseURL = input.baseURL.trim();
  const apiKey = input.apiKey.trim();
  if (!baseURL || !apiKey) {
    throw new WorkerManagerError(
      CLAUDE_SDK_CREDENTIALS_UNAVAILABLE,
      'The model route has no gateway address or no key',
      true
    );
  }
  const launch = claudeSdkHostLaunch(input.generation);
  Object.assign(launch.env, {
    // From the plan (decision 3); the key goes by IPC, never here (S-3 K-5).
    AICLIENT_CLAUDE_SDK_BASE_URL: baseURL,
    // The catalog's windows the CLI would not know (user 2026-10-18); numbers only.
    ...(input.modelWindows && Object.keys(input.modelWindows).length > 0
      ? { [CLAUDE_SDK_MODEL_WINDOWS_ENV]: JSON.stringify(input.modelWindows) }
      : {}),
    // User 2026-10-23: the developer setting as this host starts.
    [CLAUDE_SDK_AUTO_COMPACT_PERCENT_ENV]: String(claudeSdkAutoCompactPercent()),
    [CLAUDE_SDK_DROP_EMPTY_SYSTEM_ENV]: claudeSdkDropEmptySystem() ? '1' : '0',
  });
  return new ClaudeSdkProcessTransport({
    command: launch.node,
    args: [launch.entry],
    cwd: launch.configDir,
    env: launch.env,
    apiKey,
    // Dsh-rebase decision 196: the product proxy goes with the key, never in `env`.
    proxy: { current: () => getEngineProxySetting(), subscribe: onEngineProxyChange },
  });
}

/**
 * What every SDK host process starts with, a chat's or a catalog's: the Node the DSH host
 * runs on, the host entry, the app's config dir and the launch environment without a
 * gateway. Throws `CLAUDE_SDK_HOST_UNAVAILABLE` when this build cannot start one.
 */
export function claudeSdkHostLaunch(generation: number): {
  node: string;
  entry: string;
  configDir: string;
  env: Record<string, string>;
} {
  let node: string;
  try {
    ({ node } = resolveDshHostLayout({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }));
  } catch (error) {
    throw new WorkerManagerError(
      CLAUDE_SDK_HOST_UNAVAILABLE,
      `The Claude Agent SDK host cannot be started: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }
  const layout = claudeSdkHostLayout({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const entry = layout.entry;
  if (!existsSync(entry)) {
    throw new WorkerManagerError(
      CLAUDE_SDK_HOST_UNAVAILABLE,
      `The Claude Agent SDK host is missing: ${entry}`,
      true
    );
  }
  const cli = claudeSdkCliPath(layout);
  if (!cli) {
    throw new WorkerManagerError(
      CLAUDE_SDK_HOST_UNAVAILABLE,
      `The Claude Agent SDK host has no CLI binary: ${layout.cliCandidates.join(' | ')}`,
      true
    );
  }
  const dev = claudeSdkHostDevSettings(app.isPackaged, process.env);
  const configDir = path.join(getAppStateRoot(), CLAUDE_SDK_HOME_DIR_NAME);
  ensurePrivateDirectory(configDir);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && HOST_INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  Object.assign(env, {
    AICLIENT_CLAUDE_SDK_GENERATION: String(generation),
    AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
    // Ruling 19: the user layer is this app's config dir (`configDir`), never ~/.claude;
    // S-3 P-1 (ruling 5): the project's settings and CLAUDE.md, and the user's private
    // project settings (`.claude/settings.local.json`, CLAUDE.local.md). A scratch chat
    // reads neither of the last two (the host closes them). Dev override only when
    // unpackaged (S-4 B-5).
    AICLIENT_CLAUDE_SDK_SETTING_SOURCES: dev.settingSources,
    AICLIENT_CLAUDE_SDK_CLIENT_APP: `pilab/${app.getVersion()}`,
    // S-4 B-4: the CLI binary the availability check found, never the SDK's own lookup.
    AICLIENT_CLAUDE_SDK_CLI: cli,
    // Dev override: PiLab's bundled `rg` (@vscode/ripgrep) instead of the CLI's built-in one.
    ...(dev.rgDir ? { AICLIENT_CLAUDE_SDK_RG_DIR: dev.rgDir } : {}),
  });
  return { node, entry, configDir, env };
}
