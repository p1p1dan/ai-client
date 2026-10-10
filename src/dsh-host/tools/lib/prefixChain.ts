/**
 * Decision 173 (GitHub issue #9), A: the prompt prefix chains of the requests
 * the fake gateway captured (`--capture <dir>`, one `<seq>.json` per POST).
 *
 * Only anthropic-messages requests count: a POST to a path ending in
 * `/messages` (query aside) with an `anthropic-version` header and a JSON
 * body holding `messages`. Each goes on the chain of its session, the way a
 * gateway names one: the `session_id` of a JSON `metadata.user_id` (Claude
 * Code's form, which the host's request tap writes), else the `user_id`
 * itself, else the X-Pilab-Client header. With `byPurpose` a chain is split
 * into lanes by purpose, as the host's prefix watch keeps them: a compaction
 * request (DSH's compaction instruction is its last user message) is not
 * compared with the agent steps around it. Without, a chain is what one
 * upstream prompt cache sees of the session.
 *
 * Each request is compared with the one before it on its lane by the host's
 * own rules (`prefixUnitsOf` with the captured `anthropic-beta` header, then
 * `comparePrefix`), so a verdict here reads as the host's `prefix-watch` line
 * would. What leaves this module is sequence numbers, counts, ids and verdict
 * fields (`verdictLogFields`): never a hash, never a byte of content.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientPrefixVerdict } from '../../../shared/types/requestScope.ts';
import {
  comparePrefix,
  type PrefixUnits,
  prefixUnitsOf,
  verdictLogFields,
} from '../../lib/requestPrefix.ts';

/** One `<seq>.json` the gateway wrote. */
export interface CapturedRequest {
  seq: number;
  path: string;
  method: string;
  /** `anthropic-beta`, `anthropic-version`, `x-pilab-client`, `user-agent`; null when absent. */
  headers: Record<string, string | null>;
  /** The raw request body. */
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerOf(headers: unknown, name: string): string | null {
  const value = isRecord(headers) ? headers[name] : undefined;
  return typeof value === 'string' ? value : null;
}

/** Every `<seq>.json` in `dir` by sequence number; files that do not read as one are named. */
export function loadCapturedRequests(dir: string): {
  requests: CapturedRequest[];
  unreadable: string[];
} {
  const requests: CapturedRequest[] = [];
  const unreadable: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!isRecord(raw) || typeof raw.seq !== 'number' || typeof raw.body !== 'string') {
        unreadable.push(name);
        continue;
      }
      requests.push({
        seq: raw.seq,
        path: typeof raw.path === 'string' ? raw.path : '',
        method: typeof raw.method === 'string' ? raw.method : '',
        headers: {
          'anthropic-beta': headerOf(raw.headers, 'anthropic-beta'),
          'anthropic-version': headerOf(raw.headers, 'anthropic-version'),
          'x-pilab-client': headerOf(raw.headers, 'x-pilab-client'),
          'user-agent': headerOf(raw.headers, 'user-agent'),
        },
        body: raw.body,
      });
    } catch {
      unreadable.push(name);
    }
  }
  requests.sort((a, b) => a.seq - b.seq);
  return { requests, unreadable };
}

/** The highest sequence number captured in `dir` so far; 0 when none. */
export function lastCapturedSeq(dir: string): number {
  let last = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last;
}

/** A POST to `…/messages` (query aside) carrying `anthropic-version`. */
export function isAnthropicMessagesCapture(request: CapturedRequest): boolean {
  const path = request.path.split('?')[0] ?? '';
  return (
    request.method.toUpperCase() === 'POST' &&
    path.endsWith('/messages') &&
    request.headers['anthropic-version'] !== null
  );
}

/** `metadata.user_id` as a gateway reads it. */
export interface UserIdInfo {
  /**
   * `json` Claude Code's JSON string; `legacy` `user_…_account_…_session_<id>`;
   * `other` any other string; `invalid` not a string; `absent` none.
   */
  format: 'json' | 'legacy' | 'other' | 'invalid' | 'absent';
  /** The keys of `metadata`, sorted; absent without one. */
  metadataKeys?: string[];
  /** The JSON form's own keys, in order. */
  keys?: string[];
  deviceId?: string;
  accountUuid?: string;
  /** The session it names (the JSON form's `session_id`, or the legacy form's tail). */
  sessionId?: string;
}

export function userIdOf(body: unknown): UserIdInfo {
  const metadata = isRecord(body) ? body.metadata : undefined;
  if (!isRecord(metadata) || !Object.hasOwn(metadata, 'user_id')) {
    return {
      format: 'absent',
      ...(isRecord(metadata) ? { metadataKeys: Object.keys(metadata).sort() } : {}),
    };
  }
  const metadataKeys = Object.keys(metadata).sort();
  const userId = metadata.user_id;
  if (typeof userId !== 'string') return { format: 'invalid', metadataKeys };
  if (userId.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(userId);
      if (isRecord(parsed)) {
        const text = (key: string) => (typeof parsed[key] === 'string' ? parsed[key] : undefined);
        const sessionId = text('session_id');
        const deviceId = text('device_id');
        const accountUuid = text('account_uuid');
        return {
          format: 'json',
          metadataKeys,
          keys: Object.keys(parsed),
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(accountUuid !== undefined ? { accountUuid } : {}),
          ...(sessionId ? { sessionId } : {}),
        };
      }
    } catch {
      // Not JSON after all: try the legacy form.
    }
  }
  const legacy = /^user_.+_account_.*_session_(.+)$/.exec(userId);
  return legacy
    ? { format: 'legacy', metadataKeys, sessionId: legacy[1] }
    : { format: 'other', metadataKeys };
}

/** DSH's compaction request ends with this instruction (dsh-compaction-basic). */
const COMPACTION_INSTRUCTION = 'You are now acting as a compaction engine';

function textOf(message: unknown): string {
  if (!isRecord(message)) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (isRecord(block) && block.type === 'text' ? String(block.text ?? '') : ''))
    .join('\n');
}

/** `compaction` when the last message is DSH's compaction instruction, else `agent`. */
export function requestPurposeOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages[messages.length - 1];
  return isRecord(last) && last.role === 'user' && textOf(last).includes(COMPACTION_INSTRUCTION)
    ? 'compaction'
    : 'agent';
}

/** One request on its lane. */
export interface ChainedRequest {
  seq: number;
  /** The session key: `session:<id>`, `user:<user_id>` or `client:<X-Pilab-Client>`. */
  chain: string;
  purpose: string;
  userId: UserIdInfo;
  clientHeader: string | null;
  messages: number;
  bodyChars: number;
  /** The lane's request before this one. */
  prevSeq?: number;
  /** Position on the lane, from 1. */
  position: number;
  /** Undefined when the body could not be hashed: the lane starts over after it. */
  verdict?: ClientPrefixVerdict;
  /** `verdictLogFields`, or `unhashed`. */
  fields: string;
}

export type LaneCounts = Record<'first' | 'same' | 'append' | 'diverged' | 'unhashed', number>;

export interface PrefixLane {
  /** `<chain>` alone, or `<chain> <purpose>` with `byPurpose`. */
  lane: string;
  chain: string;
  /** The lane's purpose with `byPurpose`, else `*`. */
  purpose: string;
  /** The session the chain is named after, when a `user_id` names one. */
  sessionId?: string;
  requests: ChainedRequest[];
  counts: LaneCounts;
}

export interface PrefixChains {
  lanes: PrefixLane[];
  /** Anthropic-messages requests by sequence number, each with its verdict. */
  requests: ChainedRequest[];
  /** Captures left out: another wire, or a body that is no Messages request. */
  skipped: Array<{ seq: number; reason: string }>;
}

function chainKeyOf(userId: UserIdInfo, clientHeader: string | null, rawUserId: unknown): string {
  if (userId.sessionId) return `session:${userId.sessionId}`;
  if (typeof rawUserId === 'string') return `user:${rawUserId}`;
  return `client:${clientHeader ?? '-'}`;
}

/**
 * The chains of `captured` (any order; sorted here). `purposeOf` names a
 * request's purpose, `requestPurposeOf` by default.
 */
export function buildPrefixChains(
  captured: readonly CapturedRequest[],
  options: {
    byPurpose?: boolean;
    purposeOf?: (body: Record<string, unknown>, request: CapturedRequest) => string;
  } = {}
): PrefixChains {
  const purposeOf = options.purposeOf ?? requestPurposeOf;
  const lanes = new Map<string, PrefixLane & { units?: PrefixUnits }>();
  const requests: ChainedRequest[] = [];
  const skipped: PrefixChains['skipped'] = [];
  for (const request of [...captured].sort((a, b) => a.seq - b.seq)) {
    if (!isAnthropicMessagesCapture(request)) {
      skipped.push({ seq: request.seq, reason: `not anthropic-messages (${request.path})` });
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      skipped.push({ seq: request.seq, reason: 'body is not JSON' });
      continue;
    }
    if (!isRecord(body) || !Array.isArray(body.messages)) {
      skipped.push({ seq: request.seq, reason: 'body has no messages' });
      continue;
    }
    const userId = userIdOf(body);
    const clientHeader = request.headers['x-pilab-client'] ?? null;
    const rawUserId = isRecord(body.metadata) ? body.metadata.user_id : undefined;
    const chain = chainKeyOf(userId, clientHeader, rawUserId);
    const purpose = options.byPurpose ? purposeOf(body, request) : '*';
    const key = options.byPurpose ? `${chain} ${purpose}` : chain;
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        lane: key,
        chain,
        purpose,
        ...(userId.sessionId ? { sessionId: userId.sessionId } : {}),
        requests: [],
        counts: { first: 0, same: 0, append: 0, diverged: 0, unhashed: 0 },
      };
      lanes.set(key, lane);
    }
    const units = prefixUnitsOf(body, request.headers['anthropic-beta']);
    const verdict = units ? comparePrefix(lane.units, units) : undefined;
    const previous = lane.requests[lane.requests.length - 1];
    const chained: ChainedRequest = {
      seq: request.seq,
      chain,
      purpose,
      userId,
      clientHeader,
      messages: body.messages.length,
      bodyChars: request.body.length,
      ...(previous ? { prevSeq: previous.seq } : {}),
      position: lane.requests.length + 1,
      ...(verdict ? { verdict } : {}),
      fields: verdict ? verdictLogFields(verdict) : 'unhashed',
    };
    lane.units = units;
    lane.counts[verdict ? verdict.kind : 'unhashed'] += 1;
    lane.requests.push(chained);
    requests.push(chained);
  }
  return {
    lanes: [...lanes.values()].map(({ units: _units, ...lane }) => lane),
    requests,
    skipped,
  };
}

/** A lane as one table row: name, purpose, requests and counts by verdict. */
export function laneRow(lane: PrefixLane, name = lane.chain): string {
  const { first, append, same, diverged, unhashed } = lane.counts;
  return [
    name.padEnd(30),
    lane.purpose.padEnd(11),
    `reqs ${String(lane.requests.length).padStart(3)}`,
    `first ${first}`,
    `append ${String(append).padStart(3)}`,
    `same ${same}`,
    `diverged ${diverged}`,
    ...(unhashed > 0 ? [`unhashed ${unhashed}`] : []),
  ].join('  ');
}

const UNBROKEN: ReadonlySet<string> = new Set(['first', 'append', 'same']);

/** Whether a request does not merely start or extend its lane: diverged, or unhashed. */
export function isBreak(request: ChainedRequest): boolean {
  return !UNBROKEN.has(request.verdict?.kind ?? 'unhashed');
}

/** The lane's breaks, as `seq <n> (req <position>) <fields>`. */
export function laneBreaks(lane: PrefixLane): string[] {
  return lane.requests
    .filter(isBreak)
    .map((request) => `seq ${request.seq} (req ${request.position}) ${request.fields}`);
}
