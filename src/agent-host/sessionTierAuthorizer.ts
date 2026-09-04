/**
 * U12 — session-level permission tier authorizer.
 *
 * An inline pi extension that registers an `authorizerChain` link named
 * `aiclient-session-tier`. The link reads the current tier from a mutable
 * state holder exposed to the Worker RPC layer, so a tier change from the
 * renderer takes effect on the very next permission gate — no restart, no
 * re-bootstrap.
 *
 * ## How the four tiers map to verdicts
 *
 * | Tier       | write/edit | bash  | everything else |
 * |------------|-----------|-------|-----------------|
 * | readonly   | deny      | deny  | defer           |
 * | pragmatic  | defer     | defer | defer           |
 * | handsoff   | allow     | defer | defer           |
 * | fullopen   | allow     | allow | allow           |
 *
 * The delegation envelope (`DELEGATION_EXCLUDED_SURFACES`) caps any `allow`
 * on `path` or `external_directory` to `defer`, so even `fullopen` cannot
 * bypass the secret-file deny rules or cross-directory confirmation.
 *
 * ## Why an inline extension
 *
 * Same reason as `permissionActivity.ts`: the `registerAuthorizer` API lives
 * on `PermissionsService`, reachable only through the extension event bus.
 * An inline factory needs no file on disk.
 */

import type { SessionPermissionTier } from '../shared/types/sessionPermissionTier.ts';

// ── Restated types ──────────────────────────────────────────────────────────
// Declared locally to avoid importing from the plugin under jiti isolation,
// where each extension gets its own module copy and cross-copy type identity
// would break.

interface SessionTierExtensionApi {
  events?: {
    on?: (channel: string, handler: (data: unknown) => void) => (() => void) | undefined;
  };
}

type AuthorizerVerdict = { kind: 'allow' } | { kind: 'deny'; reason?: string } | { kind: 'defer' };

interface AuthorizerDetails {
  surface?: string | null;
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

/** Pure verdict logic — no side effects, trivially testable. */
export function verdictForTier(
  tier: SessionPermissionTier,
  surface: string | undefined
): AuthorizerVerdict {
  switch (tier) {
    case 'readonly': {
      if (surface === 'write' || surface === 'edit' || surface === 'bash') {
        return { kind: 'deny', reason: 'This session is in read-only mode.' };
      }
      return { kind: 'defer' };
    }
    case 'pragmatic':
      return { kind: 'defer' };
    case 'handsoff': {
      if (surface === 'write' || surface === 'edit') {
        return { kind: 'allow' };
      }
      return { kind: 'defer' };
    }
    case 'fullopen':
      return { kind: 'allow' };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SessionTierAuthorizerState {
  setTier(tier: SessionPermissionTier): void;
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

  const state: SessionTierAuthorizerState = {
    setTier(tier) {
      currentTier = tier;
    },
    getTier() {
      return currentTier;
    },
  };

  const factory = (pi: unknown): void => {
    const ext = pi as SessionTierExtensionApi | null | undefined;
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
            const tier = currentTier;
            const surface = effectiveSurface(details);
            const verdict = verdictForTier(tier, surface);
            authLog.review('session-tier', { tier, surface, verdict: verdict.kind });
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
