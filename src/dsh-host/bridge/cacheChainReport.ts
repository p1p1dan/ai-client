/**
 * Decision 173 B2 (GitHub issue #9) in the bridge: what the model plan says of
 * a route's prompt cache, which prefix evidence belongs to a step, and the log
 * lines a step's cache verdict writes.
 *
 * The verdicts come from the session's cache chain (`shared/cacheChain.ts`),
 * which the history cache folds (`historyCache.ts`); the live translation
 * (`liveEvents.ts`) sends a notable one with the step's settled usage
 * (`buildPiUsageCacheStep`) and writes these lines to the bridge's log, which
 * Main keeps in the app log. Numbers and ids only: never content, never a hash.
 */

import {
  type CacheChainOptions,
  type CacheStepRef,
  type CacheStepVerdict,
  DEFAULT_TTL_MS,
  isUnexplainedVerdict,
} from '../../shared/cacheChain.ts';
import type { ClientPrefixEvidence, ClientPrefixVerdict } from '../../shared/types/requestScope.ts';
import type { DshBridgeModelPlan } from './modelRoute.ts';

/** What a `long` cache retention asks the provider for: Anthropic's one-hour entry. */
export const LONG_CACHE_TTL_MS = 60 * 60_000;

/** The one protocol whose prompt cache the chain follows (decision 173 §4.3). */
const FOLLOWED_PROTOCOL = 'anthropic-messages';

/** The plan's profile of route `provider`, when the plan names it. Never throws. */
function routeOf(
  plan: () => DshBridgeModelPlan | undefined,
  provider: string | undefined
): { api?: unknown; cacheRetention?: unknown } | undefined {
  if (!provider) return undefined;
  try {
    const routes = plan()?.routes;
    if (typeof routes !== 'object' || routes === null || !Object.hasOwn(routes, provider)) {
      return undefined;
    }
    const route: unknown = routes[provider];
    return typeof route === 'object' && route !== null ? route : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The chain's options, read off the host's model plan per step (DSH names a
 * step's route as `provider`, the plan's route key):
 *   cacheAware  the route speaks anthropic-messages. Any other route, and one
 *               the plan does not name (no plan, a host without routes), is
 *               recorded unjudged: it never alerts.
 *   ttlMsFor    1 h for `cacheRetention: 'long'`, 5 min for a named route's
 *               other retention; undefined for an unnamed route (the fold's
 *               default, 5 min).
 */
export function dshCacheChainOptions(
  plan: () => DshBridgeModelPlan | undefined
): CacheChainOptions {
  return {
    cacheAware: (provider) => routeOf(plan, provider)?.api === FOLLOWED_PROTOCOL,
    ttlMsFor: (provider) => {
      const route = routeOf(plan, provider);
      if (!route) return undefined;
      return route.cacheRetention === 'long' ? LONG_CACHE_TTL_MS : DEFAULT_TTL_MS;
    },
  };
}

/** When a step's requests can have been made, in epoch ms; either end may be unknown. */
export interface StepRequestWindow {
  /** The step's `step/start`. */
  readonly from?: number;
  /** Its `assistant/message`. */
  readonly to?: number;
}

/**
 * The prefix evidence that belongs to a step, or undefined. The host keeps
 * one finding per session, on its newest agent-loop request — or, when a
 * retry repeats a request (`same`), on the request it repeats — so it is the
 * step's own when that request was seen (`at`) inside the step's window,
 * from its `step/start` to its `assistant/message`: every attempt of a step
 * is made there, and no other step's is. Not one handed to an earlier step
 * either (`given`, by request number and time: the host restarts the count
 * after a long idle). Evidence from before the window means the watch never
 * saw this step's request (switched off, not an anthropic-messages request,
 * no session in its async context); a window with an unknown end proves
 * nothing. Both give none: a missing `prefix` means "not known", never "fine".
 */
export function stepPrefixEvidence(
  evidence: ClientPrefixEvidence | undefined,
  window: StepRequestWindow,
  given?: Pick<ClientPrefixEvidence, 'requestSeq' | 'at'>
): ClientPrefixEvidence | undefined {
  const { from, to } = window;
  if (!evidence || from === undefined || to === undefined) return undefined;
  if (!Number.isFinite(evidence.at) || evidence.at < from || evidence.at > to) return undefined;
  if (given && evidence.requestSeq === given.requestSeq && evidence.at === given.at) {
    return undefined;
  }
  return evidence;
}

/** `t<turn>s<step>`, DSH's coordinates. */
function stepName(ref: CacheStepRef): string {
  return `t${ref.turn}s${ref.step}`;
}

/** A name fit for a log line: a short identifier, else `?`. */
function logToken(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '?';
}

/** Where a diverged request first differed, as `requestPrefix.ts` writes it in the host. */
function divergenceFields(verdict: Extract<ClientPrefixVerdict, { kind: 'diverged' }>): string {
  const index = verdict.index ?? '?';
  switch (verdict.at) {
    case 'config':
      return `at=config field=${logToken(verdict.field)}`;
    case 'tools':
      return `at=tools index=${index}`;
    case 'messages':
      return `at=messages index=${index}/${verdict.messages} role=${logToken(verdict.role)} truncated=${verdict.truncated}`;
    default:
      return `at=${logToken(verdict.at)}`;
  }
}

/**
 * The lines a step's verdict writes to the log; none for most steps.
 *
 * A notable step nothing local explains (`isUnexplainedVerdict`): the
 * upstream did not serve what the step before cached —
 *
 *   cache-chain: upstream cache inconsistency session=aiclient-… step=t1s17
 *     kind=rebuild prompt=174880 prev=157890 read=36848 write=138030
 *     lost=121042 matched=- prefix=append
 *
 * (`matched`: the older step whose cache was read, `t<turn>s<step>`; `prefix`:
 * the step's request against the one before, `-` when unknown). An explained
 * step writes nothing.
 *
 * A step whose request diverged from the session's previous request while no
 * local event since the step before explains a change — the client's own
 * prefix moved, which is ours to fix:
 *
 *   cache-chain: client request diverged without a logged cause
 *     session=aiclient-… step=t1s17 at=messages index=41/72 role=assistant
 *     truncated=false request=18
 *
 * (each on one line).
 */
export function cacheChainLogLines(
  sessionId: string,
  verdict: CacheStepVerdict,
  evidence?: ClientPrefixEvidence
): string[] {
  const lines: string[] = [];
  const at = `session=${sessionId} step=${stepName(verdict)}`;
  if (isUnexplainedVerdict(verdict)) {
    lines.push(
      [
        `cache-chain: upstream cache inconsistency ${at}`,
        `kind=${verdict.kind}`,
        `prompt=${verdict.prompt}`,
        `prev=${verdict.prevPrompt ?? '-'}`,
        `read=${verdict.read}`,
        `write=${verdict.write}`,
        `lost=${verdict.lost}`,
        `matched=${verdict.matched ? stepName(verdict.matched) : '-'}`,
        `prefix=${evidence?.verdict.kind ?? '-'}`,
      ].join(' ')
    );
  }
  if (evidence?.verdict.kind === 'diverged' && verdict.causes.length === 0) {
    lines.push(
      `cache-chain: client request diverged without a logged cause ${at} ${divergenceFields(evidence.verdict)} request=${evidence.requestSeq}`
    );
  }
  return lines;
}
