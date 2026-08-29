/**
 * Permission activity observer — T08-b.
 *
 * `@gotgenes/pi-permission-system` broadcasts two events on pi's extension bus:
 * `permissions:ui_prompt` just before it shows a prompt, and
 * `permissions:decision` after every gate resolves. This module registers a
 * tiny INLINE extension that listens to both and projects them onto our
 * `permission.activity` runtime event.
 *
 * ## Why bother, when the modal already asks the user
 *
 * Two things the modal cannot tell them:
 *
 *  - **The decisions nobody was asked about.** A `policy_allow` resolves with no
 *    prompt at all. Without this listener there is no evidence anywhere that the
 *    call was gated rather than simply unchecked — and "the permission system is
 *    silently not running" looks exactly the same.
 *  - **What was decided, after the modal is gone.** The dialog disappears on
 *    answer; the timeline should still say what was approved and how.
 *
 * ## Why an inline extension rather than a hook in our own code
 *
 * The bus is `ExtensionAPI.events`, which only exists inside an extension. pi
 * gives us `resourceLoaderOptions.extensionFactories` for exactly this, and an
 * inline factory needs no file on disk and no package to install.
 *
 * ## Discipline
 *
 * Read-only. This listener never decides, delays, or vetoes anything — the
 * plugin's own emit helpers swallow listener errors on purpose ("a consumer
 * failure must not block the permission dialog itself"), so anything thrown here
 * would be silently discarded rather than usefully reported. It therefore
 * catches its own errors and keeps going.
 */

import type { RuntimeEvent } from '../shared/types/runtimeEvents.ts';

export const PERMISSIONS_UI_PROMPT_CHANNEL = 'permissions:ui_prompt';
export const PERMISSIONS_DECISION_CHANNEL = 'permissions:decision';

/**
 * The slice of pi's `ExtensionAPI` this observer touches.
 *
 * `on` returns an unsubscribe function OR nothing — written as `| undefined`
 * rather than `| void`, which reads as "this union member is the absence of a
 * return" and is what `noConfusingVoidType` flags. Nothing here unsubscribes
 * (the observer lives as long as its session), so the return is only ever
 * discarded; the type exists to describe pi's shape honestly.
 */
interface PermissionEventApi {
  events?: {
    on?: (channel: string, handler: (data: unknown) => void) => (() => void) | undefined;
  };
}

type ActivityPayload = Extract<RuntimeEvent, { type: 'permission.activity' }>['payload'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * `permissions:ui_prompt` → our payload.
 *
 * `undefined` when the broadcast carries no `requestId`: that is the only field
 * that ties a prompt to the decision that follows it, and a record that cannot
 * be correlated is noise in a timeline rather than evidence.
 */
export function projectUiPromptEvent(data: unknown): ActivityPayload | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const raw = data as Record<string, unknown>;
  const requestId = str(raw.requestId);
  if (!requestId) return undefined;
  const forwarding = raw.forwarding as Record<string, unknown> | null | undefined;
  return {
    phase: 'prompt',
    requestId,
    ...(str(raw.surface) ? { surface: str(raw.surface) } : {}),
    ...(str(raw.value) ? { value: str(raw.value) } : {}),
    ...(str(raw.agentName) ? { agentName: str(raw.agentName) } : {}),
    // Present-and-non-null is the plugin's own signal for "this came from a
    // subagent"; the key exists as `null` on an ordinary local prompt.
    ...(forwarding ? { forwarded: true } : {}),
    ...(forwarding && str(forwarding.requesterAgentName)
      ? { requesterAgentName: str(forwarding.requesterAgentName) }
      : {}),
  };
}

/** `permissions:decision` → our payload. Same correlation rule as above. */
export function projectDecisionEvent(data: unknown): ActivityPayload | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const raw = data as Record<string, unknown>;
  const requestId = str(raw.requestId);
  if (!requestId) return undefined;
  const forwarding = raw.forwarding as Record<string, unknown> | null | undefined;
  return {
    phase: 'decision',
    requestId,
    ...(str(raw.surface) ? { surface: str(raw.surface) } : {}),
    ...(str(raw.value) ? { value: str(raw.value) } : {}),
    ...(str(raw.agentName) ? { agentName: str(raw.agentName) } : {}),
    // Only the two documented outcomes are accepted. An unrecognized `result` is
    // dropped rather than passed through, because a timeline that renders an
    // unknown word beside a tool call reads as though it were a real verdict.
    ...(raw.result === 'allow' || raw.result === 'deny' ? { result: raw.result } : {}),
    // `resolution` IS passed through verbatim — it is a third-party enum on a
    // best-effort broadcast, and narrowing it here would make a plugin upgrade
    // that adds a value look like a missing decision.
    ...(str(raw.resolution) ? { resolution: str(raw.resolution) } : {}),
    ...(str(raw.origin) ? { origin: str(raw.origin) } : {}),
    ...(str(raw.matchedPattern) ? { matchedPattern: str(raw.matchedPattern) } : {}),
    ...(forwarding ? { forwarded: true } : {}),
    ...(forwarding && str(forwarding.requesterAgentName)
      ? { requesterAgentName: str(forwarding.requesterAgentName) }
      : {}),
  };
}

export interface PermissionActivityObserverOptions {
  /** Called with each projected payload; the caller wraps it as a RuntimeEvent. */
  onActivity: (payload: ActivityPayload) => void;
  log?: (...args: unknown[]) => void;
}

/**
 * Build the inline extension factory to hand to
 * `resourceLoaderOptions.extensionFactories`.
 *
 * Tolerant of an SDK or plugin that does not provide the bus: it returns
 * quietly, because the permission SYSTEM still works without an observer and
 * failing the bind would trade a working gate for a missing log line.
 */
export function createPermissionActivityObserver(options: PermissionActivityObserverOptions) {
  const log = options.log ?? (() => undefined);

  return (pi: PermissionEventApi): void => {
    const bus = pi?.events;
    if (typeof bus?.on !== 'function') {
      log('extension event bus unavailable; permission activity will not be recorded');
      return;
    }
    const subscribe = (
      channel: string,
      project: (data: unknown) => ActivityPayload | undefined
    ) => {
      try {
        bus.on?.(channel, (data) => {
          try {
            const payload = project(data);
            if (payload) options.onActivity(payload);
          } catch (error) {
            // Never propagate: the plugin discards listener throws anyway, so
            // rethrowing would lose the reason AND achieve nothing.
            log(`permission activity handler failed on ${channel}:`, error);
          }
        });
      } catch (error) {
        log(`failed to subscribe to ${channel}:`, error);
      }
    };
    subscribe(PERMISSIONS_UI_PROMPT_CHANNEL, projectUiPromptEvent);
    subscribe(PERMISSIONS_DECISION_CHANNEL, projectDecisionEvent);
  };
}
