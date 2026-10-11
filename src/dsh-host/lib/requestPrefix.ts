/**
 * Decision 173 (GitHub issue #9), B1: an anthropic-messages request's prefix,
 * unit by unit, and whether a request only extends the previous request of
 * the same session.
 *
 * A prompt cache serves the longest prefix it has seen (tools, then system,
 * then messages), so a request that is the previous one with messages
 * appended keeps the cache, and a change anywhere before the end makes the
 * upstream write everything from there again. The first change is reported,
 * looked for in this order: the config (each top-level field but the units
 * below and the ones a prompt cache does not depend on, plus the
 * `anthropic-beta` list), each tool, the system prompt, then each message.
 *
 * Normalized before hashing, so that what pi-ai moves between requests and
 * never reaches the prompt does not count:
 *   - every `cache_control` key, at any depth: pi-ai marks the system blocks,
 *     the last tool and the last user message, and the marks move on as the
 *     conversation grows;
 *   - a string `content` or `system` is the text block it stands for, so a
 *     changed text is told from a changed form;
 *   - an absent `system` is an empty one.
 * Everything else is hashed as given, key order included, since that is what
 * reaches the prompt: thinking blocks and their signatures too.
 *
 * Decision 182 (DA-3): the form is kept beside each hash. The same text sent
 * as a string where the previous request sent a block array, or the other way
 * round, is a divergence of its own (`system-form`, `message-form`), not the
 * same unit: pi-ai sends the last user message as a marked text block and as a
 * plain string once it is no longer last, and some upstreams never read the
 * cache written on that block again. The host's request tap sends every user
 * message as blocks (userContentBlocks.ts), so such a change on a session's
 * chain means something else rewrote a message.
 *
 * Hashes stay in memory; {@link verdictLogFields} writes neither hashes nor
 * content. Loaded by Node type stripping in a source checkout: erasable
 * syntax only.
 */

import { createHash } from 'node:crypto';
import type { ClientPrefixVerdict, ContentForm } from '../../shared/types/requestScope.ts';

/** One request's prefix, as hashes. */
export interface PrefixUnits {
  /** Top-level field name (or `anthropic-beta`) -> hash, in the request's order. */
  config: Record<string, string>;
  tools: string[];
  system: string;
  /** How `system` is written; an absent one is `blocks`. */
  systemForm: ContentForm;
  messages: string[];
  /** Each message's role, for the log line. */
  roles: string[];
  /** How each message writes its `content`. */
  forms: ContentForm[];
}

/**
 * Top-level fields outside the config unit: the units of their own, and the
 * ones a prompt cache does not depend on.
 */
const NOT_CONFIG: ReadonlySet<string> = new Set([
  'messages',
  'system',
  'tools',
  'metadata',
  'max_tokens',
  'stream',
  'temperature',
]);

/** The config unit of the `anthropic-beta` request header. */
const BETA_UNIT = 'anthropic-beta';

const CACHE_CONTROL = 'cache_control';
/** How a `cache_control` key shows in JSON text. */
const CACHE_CONTROL_JSON = `"${CACHE_CONTROL}"`;

function withoutCacheControl(key: string, value: unknown): unknown {
  return key === CACHE_CONTROL ? undefined : value;
}

/** The first 16 hex digits of the SHA-256 of `value` as JSON, cache marks left out. */
function hashOf(value: unknown): string {
  let text = JSON.stringify(value) ?? '';
  // The replacer runs once per key, so pay for it only where a mark is.
  if (text.includes(CACHE_CONTROL_JSON)) text = JSON.stringify(value, withoutCacheControl) ?? '';
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string is the text block it stands for. */
function asBlocks(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/** `string` for a string, `blocks` for anything else: what a form change is told by. */
function formOf(value: unknown): ContentForm {
  return typeof value === 'string' ? 'string' : 'blocks';
}

/** The beta list as a set: split on commas, trimmed, deduplicated, sorted. */
function betaList(betas: string | null | undefined): string[] {
  if (typeof betas !== 'string') return [];
  const names = betas
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return [...new Set(names)].sort();
}

/**
 * The prefix units of a request body (`JSON.parse` of what is sent) and its
 * `anthropic-beta` header; undefined unless the body is an object with a
 * `messages` array, or when it cannot be hashed.
 */
export function prefixUnitsOf(body: unknown, betas?: string | null): PrefixUnits | undefined {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return undefined;
  try {
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!NOT_CONFIG.has(key)) config[key] = hashOf(value);
    }
    const beta = betaList(betas);
    if (beta.length > 0) config[BETA_UNIT] = hashOf(beta);

    const tools = Array.isArray(body.tools)
      ? body.tools.map(hashOf)
      : body.tools === undefined
        ? []
        : [hashOf(body.tools)];

    const system =
      typeof body.system === 'string'
        ? hashOf(asBlocks(body.system))
        : hashOf(body.system === undefined ? [] : body.system);

    const messages: string[] = [];
    const roles: string[] = [];
    const forms: ContentForm[] = [];
    for (const message of body.messages as unknown[]) {
      if (isPlainObject(message)) {
        // Spread keeps `content` where it was: key order is hashed.
        messages.push(
          hashOf(
            typeof message.content === 'string'
              ? { ...message, content: asBlocks(message.content) }
              : message
          )
        );
        roles.push(typeof message.role === 'string' ? message.role : '');
        forms.push(formOf(message.content));
      } else {
        messages.push(hashOf(message));
        roles.push('');
        forms.push('blocks');
      }
    }
    return { config, tools, system, systemForm: formOf(body.system), messages, roles, forms };
  } catch {
    // A value JSON cannot write (a cycle, a BigInt): nothing to compare.
    return undefined;
  }
}

/** The first index where `prev` and `cur` differ, a length change included; -1 when equal. */
function firstDifference(prev: readonly string[], cur: readonly string[]): number {
  const shared = Math.min(prev.length, cur.length);
  for (let index = 0; index < shared; index += 1) {
    if (prev[index] !== cur[index]) return index;
  }
  return prev.length === cur.length ? -1 : shared;
}

/** The first config unit that differs, the current request's order first; undefined when none. */
function firstConfigDifference(
  prev: Readonly<Record<string, string>>,
  cur: Readonly<Record<string, string>>
): string | undefined {
  for (const key of Object.keys(cur)) {
    if (!Object.hasOwn(prev, key) || prev[key] !== cur[key]) return key;
  }
  return Object.keys(prev).find((key) => !Object.hasOwn(cur, key));
}

/** How `cur` relates to `prev`, the previous request of the same session. */
export function comparePrefix(
  prev: PrefixUnits | undefined,
  cur: PrefixUnits
): ClientPrefixVerdict {
  if (prev === undefined) return { kind: 'first' };
  const counts = { prevMessages: prev.messages.length, messages: cur.messages.length };

  const field = firstConfigDifference(prev.config, cur.config);
  if (field !== undefined) {
    return { kind: 'diverged', at: 'config', field, truncated: false, ...counts };
  }
  const tool = firstDifference(prev.tools, cur.tools);
  if (tool !== -1) {
    return { kind: 'diverged', at: 'tools', index: tool, truncated: false, ...counts };
  }
  if (prev.system !== cur.system) {
    return { kind: 'diverged', at: 'system', truncated: false, ...counts };
  }
  if (prev.systemForm !== cur.systemForm) {
    return {
      kind: 'diverged',
      at: 'system-form',
      form: cur.systemForm,
      truncated: false,
      ...counts,
    };
  }

  const index = firstDifference(prev.messages, cur.messages);
  // Before the first changed message every hash matched: a form change there
  // is the same text in another form, and comes first.
  const end = index === -1 ? cur.messages.length : index;
  for (let at = 0; at < end; at += 1) {
    const form = cur.forms[at] ?? 'blocks';
    if ((prev.forms[at] ?? 'blocks') === form) continue;
    return {
      kind: 'diverged',
      at: 'message-form',
      index: at,
      role: cur.roles[at],
      form,
      truncated: false,
      ...counts,
    };
  }
  if (index === -1) return { kind: 'same' };
  if (index === prev.messages.length) return { kind: 'append', added: cur.messages.length - index };
  // Every message `cur` has matched: it is `prev` cut short.
  const truncated = index === cur.messages.length;
  return {
    kind: 'diverged',
    at: 'messages',
    index,
    role: truncated ? prev.roles[index] : cur.roles[index],
    truncated,
    ...counts,
  };
}

/** A name fit for a log line: a short identifier, else `?`. */
function logToken(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '?';
}

/**
 * A verdict as log fields, e.g. `verdict=append added=2`,
 * `verdict=diverged at=config field=thinking`,
 * `verdict=diverged at=messages index=41/72 role=assistant truncated=false`
 * (the index out of the current request's message count) or
 * `verdict=diverged at=message-form index=4/7 role=user form=string`. Never a
 * hash, never content.
 */
export function verdictLogFields(v: ClientPrefixVerdict): string {
  switch (v.kind) {
    case 'first':
    case 'same':
      return `verdict=${v.kind}`;
    case 'append':
      return `verdict=append added=${v.added}`;
    case 'diverged': {
      const head = `verdict=diverged at=${v.at}`;
      const index = v.index ?? '?';
      if (v.at === 'config') return `${head} field=${logToken(v.field)}`;
      if (v.at === 'tools') return `${head} index=${index}`;
      if (v.at === 'messages') {
        return `${head} index=${index}/${v.messages} role=${logToken(v.role)} truncated=${v.truncated}`;
      }
      if (v.at === 'message-form') {
        return `${head} index=${index}/${v.messages} role=${logToken(v.role)} form=${logToken(v.form)}`;
      }
      if (v.at === 'system-form') return `${head} form=${logToken(v.form)}`;
      return head;
    }
  }
}
