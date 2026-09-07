import type { RuntimeEvent } from '@shared/types/runtimeEvents';

/**
 * Host status reducer for the diagnostics UI (T-09):
 * `initialHostStatus` is the placeholder until the first poll or event arrives;
 * `reduceHostStatus` folds Runtime Events reported by the Agent Host into a
 * stable, display-ready snapshot (state / pid / driver / cometix / settings
 * diagnostics / lastFatalError).
 */

export interface HostSettingsDiagnostics {
  loaded: boolean;
  hasAuthToken: boolean;
  authTokenType?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'none';
  hasBaseUrl: boolean;
  baseHost: string | null;
  model: string | null;
}

export interface HostStatus {
  /**
   * `stopped` / `ready` / `degraded` are Main's own WorkerManager states,
   * mirrored verbatim by the `ensureHost` / `getHostStatus` snapshot.
   * `starting` and `error` only ever come from Runtime Events. `unknown` is
   * this Renderer's own pre-answer value and is never sent by Main.
   */
  state: 'unknown' | 'stopped' | 'starting' | 'ready' | 'degraded' | 'error';
  /** Accepted only when reading an old event; current WorkerManager omits them. */
  pid?: number;
  driver?: string;
  cometixVersion?: string;
  nodeVersion?: string;
  nodeExecPath?: string;
  capacity?: number;
  slots?: number;
  active?: number;
  restarting?: number;
  errors?: number;
  settings?: HostSettingsDiagnostics | null;
  /**
   * Host capability flags. Unknown → undefined.
   * - `thinking`: T-04 thinking render gate.
   */
  capabilities?: { thinking?: boolean };
  lastFatalError?: string | null;
}

export const initialHostStatus: HostStatus = {
  // NOT `stopped`: nothing has been asked yet, and the two are only the same
  // fact if you assume Main answers `stopped`. Rendering the "service stopped ·
  // Retry" ribbon for a service nobody has queried is the exact misreport
  // WorkerManager.updateManagerState's own comment warns against.
  state: 'unknown',
  lastFatalError: null,
};

/**
 * Whether the WorkerManager can serve a send right now.
 *
 * `degraded` means "one pooled worker died", not "the manager is down": that
 * entry is retired on the next create/resume for its session and is the first
 * eviction candidate meanwhile (WorkerManager `isSafeToEvict`). Treating it as
 * unusable greys out the permission control and pins the model picker to the
 * "host not ready" fallback for every OTHER session until something happens to
 * retire it.
 */
export function isHostUsable(state: HostStatus['state']): boolean {
  return state === 'ready' || state === 'degraded';
}

export interface HostStatusBannerModel {
  tone: 'error' | 'notice';
  title: string;
  guidance: string;
  showRetry: boolean;
}

/**
 * What the diagnostics ribbon should say, or `null` for "say nothing".
 *
 * Pure so vitest (node env, `.ts` only) can cover it, like the rest of this
 * file — the ribbon itself is a `.tsx` the config cannot render, and this is
 * the decision worth testing. Three states deliberately render nothing:
 * - `ready`, the ordinary case;
 * - `unknown`, where the mount-time prime has simply not answered yet — a
 *   ribbon here is a guess about a service that is almost always up;
 * - `degraded`, which `isHostUsable` above calls usable. The session whose
 *   worker died reports its own error in its own timeline; a global ribbon
 *   claiming the service is down would contradict the composer that keeps
 *   answering next to it.
 */
export function describeHostStatus(status: HostStatus): HostStatusBannerModel | null {
  switch (status.state) {
    case 'error':
      return {
        tone: 'error',
        title: status.lastFatalError ?? 'Pi session service 出错',
        guidance: '点击 Retry 重新初始化 Pi session service',
        showRetry: true,
      };
    case 'stopped':
      return {
        tone: 'notice',
        // Reachable only when Main was asked and answered `stopped` — i.e. the
        // `ensureHost` prime failed or the app is shutting down.
        title: 'Pi session service 已停止',
        guidance: '点击 Retry 初始化 Pi session service',
        showRetry: true,
      };
    case 'starting':
      return {
        tone: 'notice',
        title: 'Pi session service 正在启动…',
        guidance: '',
        showRetry: false,
      };
    default:
      return null;
  }
}

function readPayload(event: RuntimeEvent): Record<string, unknown> | undefined {
  const payload = (event as { payload?: unknown }).payload;
  if (payload && typeof payload === 'object') {
    return payload as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Apply a Runtime Event to the snapshot. `host.ready` absorbs Node/Cometix/
 * settings diagnostics; fatal `host.error` flips state to `error` and records
 * the message; non-fatal `host.error` only surfaces in error UI elsewhere
 * (Composer lastError) and is ignored here to avoid masking readiness.
 */
export function reduceHostStatus(prev: HostStatus, event: RuntimeEvent): HostStatus {
  switch (event.type) {
    case 'host.ready': {
      const payload = readPayload(event) ?? {};
      const settingsRaw = payload.settings;
      const settings: HostSettingsDiagnostics | null =
        settingsRaw && typeof settingsRaw === 'object'
          ? (settingsRaw as HostSettingsDiagnostics)
          : null;
      const capRaw = payload.capabilities;
      const thinkingRaw =
        capRaw && typeof capRaw === 'object'
          ? (capRaw as { thinking?: unknown }).thinking
          : undefined;
      // Preserve undefined when the flag is absent (T-04 default-on rendering).
      const capabilities =
        capRaw && typeof capRaw === 'object'
          ? {
              thinking: typeof thinkingRaw === 'boolean' ? thinkingRaw : undefined,
            }
          : prev.capabilities;
      return {
        ...prev,
        state: payload.shuttingDown ? 'stopped' : 'ready',
        driver: typeof payload.driver === 'string' ? payload.driver : prev.driver,
        cometixVersion:
          typeof payload.cometixVersion === 'string' ? payload.cometixVersion : prev.cometixVersion,
        nodeVersion:
          typeof payload.nodeVersion === 'string' ? payload.nodeVersion : prev.nodeVersion,
        nodeExecPath:
          typeof payload.nodeExecPath === 'string' ? payload.nodeExecPath : prev.nodeExecPath,
        settings,
        capabilities,
        lastFatalError: null,
      };
    }
    case 'host.error': {
      const payload = readPayload(event) ?? {};
      const fatal = Boolean(payload.fatal);
      const message = typeof payload.message === 'string' ? payload.message : 'host.error';
      if (!fatal) {
        return prev;
      }
      return { ...prev, state: 'error', lastFatalError: message };
    }
    default:
      return prev;
  }
}

/** The `ensureHost()` / `getHostStatus()` IPC snapshot shape — NOT a Runtime Event. */
export interface HostStatusPrimeSnapshot {
  state?: string;
  pid?: number;
  driver?: string;
  cometixVersion?: string;
  capacity?: number;
  slots?: number;
  active?: number;
  restarting?: number;
  errors?: number;
  settings?: HostSettingsDiagnostics | null;
  /**
   * S3 slice 6 (A6): mirrors the Main runtime readiness capabilities snapshot.
   * Optional/nullable exactly like `settings`
   * above — an old Main build's snapshot simply omits the key.
   */
  capabilities?: { thinking?: boolean } | null;
}

/**
 * S7 (round-2 iteration-3 review): merges the Main-side snapshot onto the
 * placeholder/prior state — `useHostStatus.ts`'s prime call on mount.
 * Extracted so this merge (previously inline in the hook, and therefore
 * untestable under the node-env vitest config, which cannot render a React
 * hook) is a pure, unit-tested function. `settings` is part of the snapshot,
 * so a consumer mounting after the readiness event already
 * fired (e.g. `HistoryErrorNotice`, only ever mounted in session mode) kept
 * reading `settings: undefined` forever, silently pinning the catalog
 * default model instead of the Host's own.
 *
 * S3 slice 6 (A6/O6): `capabilities` (notably `.agents`) now rides this same
 * prime channel too — this file's own `settings` history above is the exact
 * mistake `capabilities` must not repeat: rev.0 of the slice 6 spec added
 * `agents` to `reduceHostStatus` only and missed that a consumer mounting
 * BEFORE the first live `host.ready` (i.e. everyone, on a cold start) learns
 * everything else from this prime call and would have read `agents` as
 * `undefined` until the first Runtime Event.
 */
export function primeHostStatus(
  prev: HostStatus,
  snapshot: HostStatusPrimeSnapshot | null | undefined
): HostStatus {
  const primedCapabilities = snapshot?.capabilities;
  return {
    ...prev,
    state: (snapshot?.state as HostStatus['state']) ?? prev.state,
    pid: snapshot?.pid,
    driver: snapshot?.driver ?? prev.driver,
    cometixVersion: snapshot?.cometixVersion ?? prev.cometixVersion,
    capacity: snapshot?.capacity ?? prev.capacity,
    slots: snapshot?.slots ?? prev.slots,
    active: snapshot?.active ?? prev.active,
    restarting: snapshot?.restarting ?? prev.restarting,
    errors: snapshot?.errors ?? prev.errors,
    // Adopt verbatim (including a confirmed `null`) whenever a snapshot
    // object actually arrived — only a failed/not-yet-resolved IPC call
    // (snapshot itself null/undefined) falls back to the prior value.
    settings: snapshot ? snapshot.settings : prev.settings,
    // Same "capabilities key present → derive fresh" rule as
    // `reduceHostStatus`'s host.ready fold above; a snapshot with no
    // `capabilities` key (old Main build) or `capabilities: null` (Host never
    // reported one yet) keeps whatever this snapshot already had.
    capabilities: primedCapabilities
      ? {
          thinking: primedCapabilities.thinking,
        }
      : prev.capabilities,
  };
}

/**
 * Node 24 resolution failures are emitted by the Main process throwing inside
 * `ensureHost`. The Renderer treats any `state=error` whose message looks like
 * a Node-resolution failure as actionable guidance (set AICLIENT_NODE24_PATH).
 */
export function isNode24ResolutionFailure(status: HostStatus): boolean {
  if (status.state !== 'error') return false;
  const message = status.lastFatalError ?? '';
  return /node 24|AICLIENT_NODE24_PATH/i.test(message);
}
