import { isExplorationCommand } from '../shared/runtimeShellPolicy.ts';
import {
  migratePermissionTier,
  type RuntimePermissionSettings,
  resolveRuntimePermission,
} from '../shared/types/runtimePermission.ts';
import type { SessionPermissionTier } from '../shared/types/sessionPermissionTier.ts';

// ── Restated types ──────────────────────────────────────────────────────────
// Declared locally to avoid importing from the plugin under jiti isolation,
// where each extension gets its own module copy and cross-copy type identity
// would break.

interface SessionTierExtensionApi {
  getActiveTools?(): string[];
  getAllTools?(): Array<{ name: string }>;
  setActiveTools?(names: string[]): void;
  on?(
    event: 'session_start' | 'before_agent_start' | 'tool_call',
    handler: (event: {
      toolName?: string;
      input?: Record<string, unknown>;
      systemPrompt?: string;
    }) => unknown
  ): void;
  events?: {
    on?: (channel: string, handler: (data: unknown) => void) => (() => void) | undefined;
  };
}

type AuthorizerVerdict = { kind: 'allow' } | { kind: 'deny'; reason?: string } | { kind: 'defer' };

interface AuthorizerDetails {
  surface?: string | null;
  command?: string;
  toolName?: string;
  accessIntent?: { surface?: string | null };
}

interface AuthorizerLog {
  review(event: string, details?: Record<string, unknown>): void;
  debug(event: string, details?: Record<string, unknown>): void;
}

type AuthorizeFunction = (
  details: AuthorizerDetails,
  query: unknown,
  log: AuthorizerLog
) => Promise<AuthorizerVerdict>;

interface PermissionsServiceSlice {
  registerAuthorizer(name: string, authorize: AuthorizeFunction): () => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

const LINK_NAME = 'aiclient-session-tier';
const PERMISSIONS_READY_CHANNEL = 'permissions:ready';
const SESSION_SERVICES_KEY = Symbol.for('@gotgenes/pi-permission-system:session-services');

// ── Helpers ─────────────────────────────────────────────────────────────────

function getPermissionsService(sessionId: string): PermissionsServiceSlice | undefined {
  const store = globalThis as Record<symbol, unknown>;
  const services = store[SESSION_SERVICES_KEY] as Map<string, PermissionsServiceSlice> | undefined;
  return services?.get(sessionId);
}

function effectiveSurface(details: AuthorizerDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}

const PLAN_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'bash']);

export function verdictForPermissions(
  settings: RuntimePermissionSettings,
  surface: string | undefined,
  command?: string
): AuthorizerVerdict {
  if (
    settings.mode === 'plan' &&
    (surface === 'write' ||
      surface === 'edit' ||
      (surface === 'bash' && (!command || !isExplorationCommand(command))))
  ) {
    return { kind: 'deny', reason: 'Plan mode permits inspection only.' };
  }
  if (settings.gear === 'auto') return { kind: 'allow' };
  if (settings.gear === 'accept-edits' && ['write', 'edit', 'bash'].includes(surface ?? ''))
    return { kind: 'allow' };
  return { kind: 'defer' };
}

export function verdictForTier(
  tier: SessionPermissionTier,
  surface: string | undefined
): AuthorizerVerdict {
  return verdictForPermissions(migratePermissionTier(tier), surface);
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SessionTierAuthorizerState {
  setTier(tier: SessionPermissionTier): void;
  configure(settings: RuntimePermissionSettings): void;
  getPermissions(): RuntimePermissionSettings;
  getTier(): SessionPermissionTier;
}

export interface SessionTierAuthorizerOptions {
  log?: (...args: unknown[]) => void;
  /**
   * Tier this authorizer starts on, before any `setTier` call.
   *
   * Exists because `setTier` needs a live worker to talk to: a tier chosen
   * before the first send, or one in force when a worker crashed and
   * respawned, could not be delivered and the runtime silently fell back to
   * the default while the UI still showed the user's choice. Main now carries
   * the tier into every spawn, so the first permission gate already sees it.
   */
  initialTier?: SessionPermissionTier;
  permissions?: RuntimePermissionSettings;
}

/**
 * Build the inline extension factory and its mutable state handle.
 *
 * The factory is handed to `resourceLoaderOptions.extensionFactories`;
 * the state handle is kept by `PiWorkerSession` so the RPC layer can
 * call `state.setTier()` without touching the extension internals.
 */
export function createSessionTierAuthorizer(options: SessionTierAuthorizerOptions = {}): {
  factory: (pi: unknown) => void;
  state: SessionTierAuthorizerState;
} {
  const log = options.log ?? (() => undefined);
  let currentTier: SessionPermissionTier = options.initialTier ?? 'pragmatic';
  let settings = resolveRuntimePermission({ tier: currentTier, ...options.permissions });
  let updateTools = () => {};

  const state: SessionTierAuthorizerState = {
    setTier(tier) {
      currentTier = tier;
      settings = migratePermissionTier(tier);
      updateTools();
    },
    configure(next) {
      settings = { ...next };
      updateTools();
    },
    getPermissions() {
      return { ...settings };
    },
    getTier() {
      return currentTier;
    },
  };

  const factory = (pi: unknown): void => {
    const ext = pi as SessionTierExtensionApi | null | undefined;
    let fullTools: string[] | undefined;
    updateTools = () => {
      if (!ext?.getActiveTools || !ext.setActiveTools) return;
      fullTools ??= ext.getActiveTools();
      const available = new Set(ext.getAllTools?.().map((tool) => tool.name) ?? fullTools);
      ext.setActiveTools(
        fullTools.filter(
          (name) => available.has(name) && (settings.mode === 'agent' || PLAN_TOOLS.has(name))
        )
      );
    };
    ext?.on?.('session_start', () => {
      fullTools = undefined;
      updateTools();
    });
    ext?.on?.('before_agent_start', (event) => {
      updateTools();
      const mode =
        settings.mode === 'plan'
          ? 'Plan mode: inspect only, use bash only for inspection, and produce an implementation plan for user approval. Do not modify files.'
          : 'Agent mode: execute the approved work.';
      return {
        systemPrompt: `${event.systemPrompt ?? ''}\n\n${mode} Permission gear: ${settings.gear}. Explicit deny rules always apply.`,
      };
    });
    ext?.on?.('tool_call', (event) => {
      if (settings.mode !== 'plan') return;
      if (
        !event.toolName ||
        !PLAN_TOOLS.has(event.toolName) ||
        (event.toolName === 'bash' &&
          (typeof event.input?.command !== 'string' || !isExplorationCommand(event.input.command)))
      ) {
        return { block: true, reason: 'Plan mode permits inspection only.' };
      }
    });
    const bus = ext?.events;
    if (typeof bus?.on !== 'function') {
      log('extension event bus unavailable; session-tier authorizer will not register');
      return;
    }
    let registered = false;
    try {
      bus.on?.(PERMISSIONS_READY_CHANNEL, (data) => {
        if (registered) return;
        try {
          const payload = data as { sessionId?: string | null } | null | undefined;
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
          if (!sessionId) {
            log('permissions:ready carried no sessionId; session-tier authorizer skipped');
            return;
          }
          const service = getPermissionsService(sessionId);
          if (!service || typeof service.registerAuthorizer !== 'function') {
            log('PermissionsService not found for session; session-tier authorizer skipped');
            return;
          }
          service.registerAuthorizer(LINK_NAME, async (details, _query, authLog) => {
            const current = { ...settings };
            const surface = effectiveSurface(details);
            const verdict = verdictForPermissions(current, surface, details.command);
            authLog.review('session-tier', { ...current, surface, verdict: verdict.kind });
            return verdict;
          });
          registered = true;
          log(`session-tier authorizer registered (tier=${currentTier})`);
        } catch (error) {
          log('session-tier authorizer registration failed:', error);
        }
      });
    } catch (error) {
      log('failed to subscribe to permissions:ready for session-tier:', error);
    }
  };

  return { factory, state };
}
