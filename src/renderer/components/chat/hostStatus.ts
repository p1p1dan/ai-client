import { type AgentWireName, isAgentWireName } from '@shared/types/agentWire';
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
  state: 'stopped' | 'starting' | 'ready' | 'error';
  pid?: number;
  driver?: string;
  cometixVersion?: string;
  nodeVersion?: string;
  nodeExecPath?: string;
  settings?: HostSettingsDiagnostics | null;
  /**
   * Host capability flags. Unknown → undefined.
   * - `thinking`: T-04 thinking render gate.
   * - `agents`: S3 slice 6 (A6) — the HostAgentRegistry's wire form
   *   (`capabilities.agents`), filtered to known `AgentWireName`s so an
   *   unrecognized slug (older renderer, newer Host) never reaches a
   *   consumer. Today's only consumer is test assertions; a stage-3 agent
   *   picker is the eventual UI reader.
   */
  capabilities?: { thinking?: boolean; agents?: AgentWireName[] };
  lastFatalError?: string | null;
}

/**
 * Drop anything that is not a recognized `AgentWireName` before it reaches
 * `HostStatus` — shared by `reduceHostStatus` and `primeHostStatus` (O6: both
 * channels must filter the same way, not just both "carry the field").
 * `undefined` means "the source did not send an agents list at all", which is
 * different from "sent an empty/all-unrecognized list".
 */
function filterAgentWireNames(value: unknown): AgentWireName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isAgentWireName);
}

export const initialHostStatus: HostStatus = {
  state: 'stopped',
  lastFatalError: null,
};

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
      const agentsRaw =
        capRaw && typeof capRaw === 'object' ? (capRaw as { agents?: unknown }).agents : undefined;
      // Preserve undefined when the flag is absent (T-04 default-on rendering).
      const capabilities =
        capRaw && typeof capRaw === 'object'
          ? {
              thinking: typeof thinkingRaw === 'boolean' ? thinkingRaw : undefined,
              // S3 slice 6 (A6): same "capabilities key present → derive fresh
              // from THIS event, never merge with prior" rule as `thinking`.
              agents: filterAgentWireNames(agentsRaw),
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
  settings?: HostSettingsDiagnostics | null;
  /**
   * S3 slice 6 (A6): mirrors `AgentHostManager.getStatus().capabilities`
   * (`AgentHostCapabilitiesInfo`). Optional/nullable exactly like `settings`
   * above — an old Main build's snapshot simply omits the key.
   */
  capabilities?: { thinking?: boolean; agents?: unknown } | null;
}

/**
 * S7 (round-2 iteration-3 review): merges the Main-side snapshot onto the
 * placeholder/prior state — `useHostStatus.ts`'s prime call on mount.
 * Extracted so this merge (previously inline in the hook, and therefore
 * untestable under the node-env vitest config, which cannot render a React
 * hook) is a pure, unit-tested function. `settings` is now part of it:
 * `AgentHostManager.getStatus()` gained the field in this same batch, but
 * nothing copied it here — a consumer mounting after `host.ready` already
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
    pid: typeof snapshot?.pid === 'number' ? snapshot.pid : undefined,
    driver: snapshot?.driver ?? prev.driver,
    cometixVersion: snapshot?.cometixVersion ?? prev.cometixVersion,
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
          agents: filterAgentWireNames(primedCapabilities.agents),
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
