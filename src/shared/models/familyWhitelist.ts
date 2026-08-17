/**
 * D48 S2 §4.2 — the family whitelist: hard-coded RULES, derived MODELS.
 *
 * The gateway's `/v1/models` answers with everything it can route (15 Claude ids
 * and 10 Codex ids on 2026-08-16 [实测 调查 04]), which is not a product surface:
 * it carries image models, an auto-review bot, five superseded Opus generations
 * and a family (`claude-fable-5`) this app has never heard of. Shipping that list
 * verbatim would make the model menu a changelog of the gateway.
 *
 * So the RULE is written down once, here, and the MODELS are derived from
 * whatever the proxy answers:
 *
 *   Claude — the three families we ship (`opus` / `sonnet` / `haiku`), latest
 *            version of each, preferring the undated alias at equal version.
 *   Codex  — every variant of the HIGHEST `gpt-<major>.<minor>` generation on
 *            offer, minus the deny-listed variants and non-chat product lines.
 *
 * Two consequences are deliberate, and both are asserted:
 *
 *  1. A new version inside a known family ships itself. `claude-opus-6` needs no
 *     code change; it wins the opus slot the day the gateway lists it.
 *  2. A NEW FAMILY NAME NEVER SHIPS ITSELF. `claude-fable-5` is live on the
 *     gateway today and is deliberately absent from the menu — adding a family
 *     is a one-line, reviewed decision, because a family we have never run is a
 *     family whose effort vocabulary, pricing and prompt behaviour are unknown.
 *
 * ## Ordering is ours, never the server's
 *
 * The order of `/v1/models` carries no documented meaning, so reading semantics
 * into it (e.g. "the first one is the default") would be a guess (B U1). But an
 * UNORDERED menu is a menu that reshuffles itself between refreshes, so this
 * module imposes its OWN stable order — Claude by family rank
 * (opus → sonnet → haiku), Codex by variant name — and the tests pin the
 * sequence, not just the set.
 *
 * ## One import edge, and it points at the leaf on purpose
 *
 * Main (the catalog service), the renderer (the menu model) and the tests all
 * read this module, so it stays near-leaf: the only runtime import is
 * `agentWire.ts`, which is itself import-free. The agent slugs come from there
 * as CONSTANTS rather than as literals — `agentWireStatic.test.ts` bans a second
 * spelling of `'claude-code'` anywhere in the tree, because a binding written
 * twice is a binding that can drift, and it is persisted. `pureModuleImports.test.ts`
 * covers this file from the renderer test tree for the rest (no react, no store).
 */

import type { AgentModelOption } from '../types/agentCatalog';
import { type AgentWireName, CLAUDE_CODE_AGENT, CODEX_AGENT } from '../types/agentWire';

/**
 * The Claude families this app ships, in MENU ORDER (most capable first).
 *
 * Adding an entry is the entire cost of adopting a new family, and removing one
 * is how a family is retired — nothing else in this file names them.
 */
export const CLAUDE_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'] as const;

export type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];

/**
 * Codex variants that are never product surface, matched on the variant suffix
 * alone (`gpt-5.4-mini` → `mini`).
 *
 * `mini` is deny-listed by the spec's own wording (§4.2); it is a cheaper tier of
 * the same generation rather than a different model, and offering both halves of
 * one generation doubles the menu without adding a decision the user can make
 * informedly.
 */
export const CODEX_DENIED_VARIANTS: readonly string[] = ['mini'];

/**
 * Ids that are on the gateway but are not chat models at all [实测 调查 04 §1]:
 * an automated reviewer and two image models. They are excluded BY NAME as well
 * as by shape, so that a rename on either side shows up as a test diff rather
 * than as a surprise row in the menu.
 */
export const CODEX_DENIED_IDS: readonly string[] = ['codex-auto-review'];

/** Non-chat product lines, matched by prefix. */
export const CODEX_DENIED_PREFIXES: readonly string[] = ['gpt-image-'];

/**
 * The three legacy Claude short names this repo persisted before D48.
 *
 * They are NOT catalog entries (the gateway rejects them outright [实测 调查 04
 * 探测 B]) — they are listed only so that ownership can be decided for a stored
 * value, which is what keeps a `sonnet` selection from being handed to Codex.
 */
export const CLAUDE_LEGACY_SHORT_NAMES: readonly string[] = ['opus', 'sonnet', 'haiku'];

interface ClaudeParsed {
  family: ClaudeModelFamily;
  /** Numeric version segments, most significant first: `claude-opus-4-5` → `[4,5]`. */
  version: number[];
  /** `YYYYMMDD` when the id carries a dated suffix, else null. */
  date: string | null;
}

interface CodexParsed {
  /** `[major, minor]` of the `gpt-<major>.<minor>` generation. */
  generation: [number, number];
  /** Everything after the generation, `''` for a bare `gpt-5.6`. */
  variant: string;
}

/** `4-5` / `5` / `4-1-20250805` → segments + optional trailing date. */
function parseVersionSegments(rest: string): { version: number[]; date: string | null } | null {
  const parts = rest.split('-').filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  let date: string | null = null;
  const last = parts[parts.length - 1];
  // A `YYYYMMDD` tail is a release stamp, not a version component — treating it
  // as one would make every dated alias outrank its undated sibling forever.
  if (/^\d{8}$/.test(last)) {
    date = last;
    parts.pop();
  }
  if (parts.length === 0) return null;

  const version: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    version.push(Number(part));
  }
  return { version, date };
}

export function parseClaudeModelId(id: string): ClaudeParsed | null {
  if (!id.startsWith('claude-')) return null;
  const rest = id.slice('claude-'.length);
  const dash = rest.indexOf('-');
  if (dash <= 0) return null;
  const family = rest.slice(0, dash);
  if (!(CLAUDE_MODEL_FAMILIES as readonly string[]).includes(family)) return null;
  const parsed = parseVersionSegments(rest.slice(dash + 1));
  if (!parsed) return null;
  return { family: family as ClaudeModelFamily, version: parsed.version, date: parsed.date };
}

export function parseCodexModelId(id: string): CodexParsed | null {
  if (CODEX_DENIED_IDS.includes(id)) return null;
  if (CODEX_DENIED_PREFIXES.some((prefix) => id.startsWith(prefix))) return null;
  const match = /^gpt-(\d+)\.(\d+)(?:-(.+))?$/.exec(id);
  if (!match) return null;
  const variant = match[3] ?? '';
  if (CODEX_DENIED_VARIANTS.includes(variant)) return null;
  return { generation: [Number(match[1]), Number(match[2])], variant };
}

/** Positional compare with missing segments read as 0, so `[5]` beats `[4,8]`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function formatVersion(version: readonly number[]): string {
  return version.join('.');
}

function titleCase(token: string): string {
  return token.length === 0 ? token : token[0].toUpperCase() + token.slice(1);
}

function claudeLabel(parsed: ClaudeParsed): string {
  const base = `Claude ${titleCase(parsed.family)} ${formatVersion(parsed.version)}`;
  if (!parsed.date) return base;
  const iso = `${parsed.date.slice(0, 4)}-${parsed.date.slice(4, 6)}-${parsed.date.slice(6, 8)}`;
  return `${base} (${iso})`;
}

function codexLabel(parsed: CodexParsed): string {
  const generation = `GPT-${parsed.generation[0]}.${parsed.generation[1]}`;
  if (parsed.variant.length === 0) return generation;
  const variant = parsed.variant.split('-').map(titleCase).join(' ');
  return `${generation} ${variant}`;
}

/** Dedupe + drop blanks, preserving first-seen order. A gateway is allowed to repeat itself. */
function normalizeIds(rawIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function filterClaude(ids: readonly string[]): AgentModelOption[] {
  const best = new Map<ClaudeModelFamily, { id: string; parsed: ClaudeParsed }>();
  for (const id of ids) {
    const parsed = parseClaudeModelId(id);
    if (!parsed) continue;
    const incumbent = best.get(parsed.family);
    if (!incumbent) {
      best.set(parsed.family, { id, parsed });
      continue;
    }
    const byVersion = compareVersions(parsed.version, incumbent.parsed.version);
    if (byVersion > 0) {
      best.set(parsed.family, { id, parsed });
      continue;
    }
    // Equal version: the undated alias wins, so the menu shows `claude-opus-4-5`
    // rather than `claude-opus-4-5-20260101`. A dated id is a pin to one build;
    // the alias is what keeps following the family.
    if (byVersion === 0 && incumbent.parsed.date !== null && parsed.date === null) {
      best.set(parsed.family, { id, parsed });
    }
  }

  const out: AgentModelOption[] = [];
  for (const family of CLAUDE_MODEL_FAMILIES) {
    const entry = best.get(family);
    if (entry) out.push({ id: entry.id, label: claudeLabel(entry.parsed) });
  }
  return out;
}

function filterCodex(ids: readonly string[]): AgentModelOption[] {
  const parsedIds: Array<{ id: string; parsed: CodexParsed }> = [];
  for (const id of ids) {
    const parsed = parseCodexModelId(id);
    if (parsed) parsedIds.push({ id, parsed });
  }
  if (parsedIds.length === 0) return [];

  let top: [number, number] = parsedIds[0].parsed.generation;
  for (const { parsed } of parsedIds) {
    if (compareVersions(parsed.generation, top) > 0) top = parsed.generation;
  }

  return parsedIds
    .filter(({ parsed }) => compareVersions(parsed.generation, top) === 0)
    .sort((a, b) => {
      // Variant name, then the raw id as a tiebreak — never the order the
      // gateway happened to answer in, which carries no documented meaning.
      if (a.parsed.variant !== b.parsed.variant) {
        return a.parsed.variant < b.parsed.variant ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(({ id, parsed }) => ({ id, label: codexLabel(parsed) }));
}

/**
 * Raw `/v1/models` ids → the menu, filtered and ordered.
 *
 * Pure and total: an empty answer, a list of nothing but unknown families and a
 * list with duplicates are all legal inputs, and all three produce a shorter menu
 * rather than a throw. The CALLER decides what an empty menu means (§4.1's fourth
 * fallback rung is `Automatic` + Retry, not an exception).
 */
export function filterAgentModelCatalog(
  agent: AgentWireName,
  rawIds: readonly string[]
): AgentModelOption[] {
  const ids = normalizeIds(rawIds);
  return agent === CODEX_AGENT ? filterCodex(ids) : filterClaude(ids);
}

/**
 * Which agent's namespace a model id belongs to, or `null` for "nobody's".
 *
 * This is the D48 §4.3/§4.6-1 cross-agent guard's judgement, and its THREE-valued
 * shape is the whole point. The rule cannot be "is it in the current catalog",
 * because §4.4-6 requires a stored selection the whitelist filtered out
 * (`gpt-5.5`, `claude-opus-4-6`) to keep working on the session that chose it —
 * a membership test would reset those to `Automatic`, which is the silent model
 * swap R11 exists to prevent.
 *
 * So the guard rejects only what it can PROVE belongs to the other runtime:
 *
 *   `claude-opus-5` / `sonnet`  → `'claude-code'`
 *   `gpt-5.6-sol` / `codex-…`   → `'codex'`
 *   anything else               → `null`, and every agent may carry it
 */
export function resolveModelAgentOwner(modelId: string): AgentWireName | null {
  const id = modelId.trim();
  if (id.length === 0) return null;
  if (id.startsWith('claude-') || CLAUDE_LEGACY_SHORT_NAMES.includes(id)) return CLAUDE_CODE_AGENT;
  if (id.startsWith('gpt-') || id.startsWith('codex-')) return CODEX_AGENT;
  return null;
}

/** `false` only when the id demonstrably belongs to the OTHER agent (§4.8-B18). */
export function isModelAllowedForAgent(agent: AgentWireName, modelId: string): boolean {
  const owner = resolveModelAgentOwner(modelId);
  return owner === null || owner === agent;
}
