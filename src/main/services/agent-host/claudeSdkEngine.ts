import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type ChatEngine,
  CLAUDE_SDK_INHERITED_ENV,
  CLAUDE_SDK_STUB_SUFFIX,
  type ClaudeSdkRoute,
  claudeSdkRouteFor,
  effectiveModelRef,
} from '@shared/claudeSdkEngine';
import type { DshModelPlan } from '@shared/dshModelPlan/types';
import { app } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { ClaudeSdkProcessTransport } from './ClaudeSdkProcessTransport';
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
export const CLAUDE_SDK_HOME_DIR_NAME = 'claude-sdk-home';

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

/** The host's entry in an unpackaged checkout; packaged builds get theirs in S-4. */
export function claudeSdkHostEntry(appPath: string): string {
  return path.join(appPath, 'src', 'claude-sdk-host', 'host.ts');
}

/**
 * Where the CLI binary the SDK starts may be: the dev override
 * (`AICLIENT_CLAUDE_SDK_CLI`), else the SDK's platform package for this OS and
 * CPU (Linux also has a musl build).
 */
export function claudeSdkCliCandidates(
  modules: string,
  platform: NodeJS.Platform,
  arch: string,
  env: NodeJS.ProcessEnv
): string[] {
  const override = env.AICLIENT_CLAUDE_SDK_CLI?.trim();
  if (override) return [override];
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';
  const base = `claude-agent-sdk-${platform}-${arch}`;
  const packages = platform === 'linux' ? [base, `${base}-musl`] : [base];
  return packages.map((name) => path.join(modules, name, binary));
}

/**
 * Can this build start the SDK host: its entry, its SDK package and the CLI
 * binary are on disk. A build without them (every installer before S-4) runs
 * every new chat on DSH, and says so once in the log.
 */
export function createClaudeSdkHostAvailability(deps: {
  appPath: () => string;
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
      const entry = claudeSdkHostEntry(deps.appPath());
      const modules = path.join(path.dirname(entry), 'node_modules', '@anthropic-ai');
      const sdk = path.join(modules, 'claude-agent-sdk', 'package.json');
      missing = [entry, sdk].find((file) => !exists(file));
      // The CLI binary too (user ruling 2026-10-16: a host that cannot start sends
      // a new chat to DSH), so a missing one is found here rather than at the first turn.
      if (missing === undefined) {
        const cli = claudeSdkCliCandidates(
          modules,
          deps.platform ?? process.platform,
          deps.arch ?? process.arch,
          deps.env ?? process.env
        );
        if (!cli.some((file) => exists(file))) missing = cli.join(' | ');
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
}

/**
 * Start one SDK host for one chat. Runs on the same Node the DSH host runs on
 * (`resolveDshHostLayout`, so `AICLIENT_DSH_NODE` applies in dev); unpackaged
 * only until S-4, from `src/claude-sdk-host/host.ts`.
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
  const entry = claudeSdkHostEntry(app.getAppPath());
  if (!existsSync(entry)) {
    throw new WorkerManagerError(
      CLAUDE_SDK_HOST_UNAVAILABLE,
      `The Claude Agent SDK host is missing: ${entry}`,
      true
    );
  }
  const configDir = path.join(getAppStateRoot(), CLAUDE_SDK_HOME_DIR_NAME);
  ensurePrivateDirectory(configDir);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && HOST_INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  Object.assign(env, {
    AICLIENT_CLAUDE_SDK_GENERATION: String(input.generation),
    AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
    // From the plan (decision 3); the key goes by IPC, never here (S-3 K-5).
    AICLIENT_CLAUDE_SDK_BASE_URL: baseURL,
    // S-3 P-1 (ruling 5): the project's settings and CLAUDE.md, and the user's private
    // project settings (`.claude/settings.local.json`, CLAUDE.local.md); never the user's
    // ~/.claude. A scratch chat reads neither (the host closes them). Dev override.
    AICLIENT_CLAUDE_SDK_SETTING_SOURCES:
      process.env.AICLIENT_CLAUDE_SDK_SETTING_SOURCES?.trim() ?? 'project,local',
    AICLIENT_CLAUDE_SDK_CLIENT_APP: `pilab/${app.getVersion()}`,
    // Dev override: another CLI binary.
    ...(process.env.AICLIENT_CLAUDE_SDK_CLI?.trim()
      ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI.trim() }
      : {}),
    // Dev override: PiLab's bundled `rg` (@vscode/ripgrep) instead of the CLI's built-in one.
    ...(process.env.AICLIENT_CLAUDE_SDK_RG_DIR?.trim()
      ? { AICLIENT_CLAUDE_SDK_RG_DIR: process.env.AICLIENT_CLAUDE_SDK_RG_DIR.trim() }
      : {}),
  });
  return new ClaudeSdkProcessTransport({
    command: node,
    args: [entry],
    cwd: configDir,
    env,
    apiKey,
  });
}
