/**
 * Issue #9 test fixtures for the Run panel's 「逐步缓存」: settled steps built
 * the way they reach the panel — `message.started` and `usage.updated` folded
 * by the real `reduceMessageMetadata` — with the host's `cache` blocks in the
 * wire shape (`PiUsageCacheStep`).
 *
 * `issue9Steps()` is the prototype's state 3 (the issue's shape, synthetic
 * numbers): 22 steps of one turn, a first write at step 1, an unexplained
 * rebuild at 15, a read of step 14's prefix at 17 and a shrink at 20.
 */
import {
  initialMetadataRegistry,
  type MetadataRegistry,
  reduceMessageMetadata,
} from '@/components/chat/messageMetadata';
import { collectSettledSteps, type RunSettledStep } from '../surfaces/runPanelModel';

export const SESSION_ID = 's1';
export const DSH_SESSION = 'aiclient-s1';
export const GATEWAY_SESSION = '5b3c9e2a-8f41-5d7e-9c3a-2e6f1b4d8a90';
export const MODEL = 'claude-opus-5-5';
/** 2026-10-10 14:05:12 local time: the prototype's turn start. */
export const TURN_START = new Date(2026, 9, 10, 14, 5, 12).getTime();

export interface CacheSessionSpec {
  unexplained?: number;
  unexplainedLostTokens?: number;
  unexplainedRebuilds?: number;
  unexplainedRewriteTokens?: number;
  gatewaySession?: string;
}

export interface StepSpec {
  turn: number;
  step: number;
  input?: number;
  read: number;
  write: number;
  output?: number;
  /** Epoch ms of the step's `message.started`. */
  at: number;
  model?: string;
  /** The `cache` block, wire shape; `session` filled with zeros unless given. */
  cache?: Record<string, unknown> & { session?: CacheSessionSpec };
  /** Only the first-byte tick arrived. */
  pending?: boolean;
  /** Cut before the provider reported anything. */
  unreported?: boolean;
}

export function stepMessageId(turn: number, step: number, dshSession = DSH_SESSION): string {
  return `dsh-${dshSession}-t${turn}-s${step}`;
}

/** A runtime event as the registry reads it, host timestamp included. */
interface FoldedEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

function fold(registry: MetadataRegistry, event: FoldedEvent): MetadataRegistry {
  return reduceMessageMetadata(registry, event);
}

/** Fold the specs' events, in order, into one chat's metadata registry. */
export function registryFrom(
  specs: readonly StepSpec[],
  registry: MetadataRegistry = initialMetadataRegistry
): MetadataRegistry {
  let next = registry;
  for (const spec of specs) {
    const input = spec.input ?? 2;
    const output = spec.output ?? 300;
    next = fold(next, {
      type: 'message.started',
      sessionId: SESSION_ID,
      timestamp: spec.at,
      payload: {
        messageId: stepMessageId(spec.turn, spec.step),
        role: 'assistant',
        model: spec.model ?? MODEL,
      },
    });
    next = fold(next, {
      type: 'usage.updated',
      sessionId: SESSION_ID,
      timestamp: spec.at + 500,
      payload: {
        input,
        output: 0,
        cacheRead: spec.read,
        cacheWrite: spec.write,
        totalTokens: input + spec.read + spec.write,
        costUsd: 0,
        pending: true,
      },
    });
    if (spec.pending) continue;
    const { session, ...cache } = spec.cache ?? {};
    next = fold(next, {
      type: 'usage.updated',
      sessionId: SESSION_ID,
      timestamp: spec.at + 4_000,
      payload: spec.unreported
        ? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            costUsd: 0,
            unreported: true,
          }
        : {
            input,
            output,
            cacheRead: spec.read,
            cacheWrite: spec.write,
            totalTokens: input + spec.read + spec.write + output,
            costUsd: 0,
            ...(spec.cache
              ? {
                  cache: {
                    turn: spec.turn,
                    step: spec.step,
                    prompt: input + spec.read + spec.write,
                    read: spec.read,
                    write: spec.write,
                    ...cache,
                    session: {
                      unexplained: 0,
                      unexplainedLostTokens: 0,
                      unexplainedRebuilds: 0,
                      unexplainedRewriteTokens: 0,
                      ...session,
                    },
                  },
                }
              : {}),
          },
    });
  }
  return next;
}

export function stepsFrom(specs: readonly StepSpec[]): RunSettledStep[] {
  return collectSettledSteps(registryFrom(specs).byMessage);
}

/** [cache read, cache write, seconds after the turn began]; input is 2 throughout. */
const ISSUE_9_STEPS: readonly (readonly [number, number, number])[] = [
  [0, 43_973, 17],
  [43_973, 14_105, 31],
  [58_078, 13_124, 43],
  [71_202, 20_630, 58],
  [91_832, 11_831, 71],
  [103_663, 25_180, 86],
  [128_843, 4_699, 110],
  [133_542, 13_799, 127],
  [147_341, 9_021, 149],
  [156_362, 5_129, 166],
  [161_491, 3_904, 183],
  [165_395, 2_118, 412],
  [167_513, 1_104, 431],
  [168_617, 1_159, 449],
  [36_848, 138_030, 470],
  [174_878, 5_389, 498],
  [169_776, 15_514, 521],
  [185_290, 6_710, 539],
  [192_000, 21_193, 561],
  [98_410, 41_748, 847],
  [140_158, 5_402, 866],
  [145_560, 3_377, 884],
];

/** The host's verdicts for the four notable steps, as `buildPiUsageCacheStep` sends them. */
const ISSUE_9_CACHE: Record<number, StepSpec['cache']> = {
  1: {
    kind: 'cold',
    explained: false,
    session: { gatewaySession: GATEWAY_SESSION },
  },
  15: {
    kind: 'rebuild',
    explained: false,
    lost: 132_930,
    rewrite: 132_930,
    prevPrompt: 169_778,
    prefix: 'append',
    session: {
      unexplained: 1,
      unexplainedLostTokens: 132_930,
      unexplainedRebuilds: 1,
      unexplainedRewriteTokens: 132_930,
      gatewaySession: GATEWAY_SESSION,
    },
  },
  17: {
    kind: 'warm',
    explained: false,
    lost: 10_493,
    prevPrompt: 180_269,
    matched: { turn: 1, step: 14 },
    prefix: 'append',
    session: {
      unexplained: 2,
      unexplainedLostTokens: 132_930,
      unexplainedRebuilds: 1,
      unexplainedRewriteTokens: 132_930,
      gatewaySession: GATEWAY_SESSION,
    },
  },
  20: {
    kind: 'shrink',
    explained: false,
    lost: 114_785,
    rewrite: 41_748,
    prevPrompt: 213_195,
    prefix: 'append',
    session: {
      unexplained: 3,
      unexplainedLostTokens: 247_715,
      unexplainedRebuilds: 2,
      unexplainedRewriteTokens: 174_678,
      gatewaySession: GATEWAY_SESSION,
    },
  },
};

export function issue9Specs(patch: (spec: StepSpec) => StepSpec = (spec) => spec): StepSpec[] {
  return ISSUE_9_STEPS.map(([read, write, seconds], index) =>
    patch({
      turn: 1,
      step: index + 1,
      read,
      write,
      at: TURN_START + seconds * 1000,
      ...(ISSUE_9_CACHE[index + 1] ? { cache: ISSUE_9_CACHE[index + 1] } : {}),
    })
  );
}

export function issue9Steps(patch?: (spec: StepSpec) => StepSpec): RunSettledStep[] {
  return stepsFrom(issue9Specs(patch));
}
