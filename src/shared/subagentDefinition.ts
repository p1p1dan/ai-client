/**
 * P5-2-1 — the subagent definition document: shape, parser, writer and limits.
 *
 * Provenance: adapted from PI-Desktop `packages/shared/src/subagent-definition.ts`
 * at commit `948ee676bdb7b31d496f6603aa03dd12eb95be35`. The format, the
 * frontmatter tolerances, the safety defaults and the caps are kept so a
 * definition written for the reference app parses here unchanged.
 *
 * It lives in `src/shared` — as it does in the reference — because THREE
 * processes need the same answer about this format: the runtime loads
 * definitions, Electron Main edits them for the management UI, and the renderer
 * types the rows it shows. P5-2-5 is what forced the move: a management UI that
 * wrote documents from its own idea of the format is exactly how a saved
 * definition loses the `permission` field nobody put a control on yet.
 *
 * Three things are ours, and each has a reason that is not taste:
 *
 * 1. **Tool names round-trip in the reference spelling, and are mapped once.**
 *    Our registry is lowercase (`read`, `glob`, ...); the reference's is
 *    capitalised (`Read`, `Glob`, ...). Documents are portable artifacts a user
 *    may have written for either app, so the parser accepts any casing and
 *    stores the capitalised canonical form — that is what a management UI must
 *    write back unchanged. {@link runtimeToolName} is the single adaptation
 *    point where it becomes a name this runtime can look up.
 * 2. **`BrowserPreview` maps to `browser_preview`, which may not be
 *    registered.** P5-2-3 landed the facade, but a host with no preview surface
 *    supplies no callback and the tool does not exist there. Dropping the name
 *    at parse time would silently rewrite the user's document and make a
 *    missing capability look like a definition that never asked for it; instead
 *    it parses, round-trips, and falls out of the live-tool intersection.
 * 3. **`idleTimeout` / `maxDuration` parse but arm nothing.** The reference
 *    withdrew both watchdogs (its D328): the parent's `TaskStop` and the user's
 *    Stop decide a delegate's lifetime, not a timer. The fields stay so old
 *    documents still load, and the constants stay so the clamping warnings a
 *    user already relies on keep their wording.
 */

import type { PermissionGear } from './types/runtimePermission.ts';

/**
 * Where a definition came from.
 *
 * `user` is a document the user owns and can edit; `builtin` is one we ship.
 * There is deliberately no `project` source: a repository must not be able to
 * add a delegate to the user's catalog just by being opened.
 */
export type SubagentDefinitionSource = 'builtin' | 'user';

/** Provider/model a definition pins, resolved against the runtime catalog. */
export interface SubagentModelPin {
  provider: string;
  modelId: string;
}

/**
 * Permission scope a delegate's tool calls resolve under.
 *
 * `inherit` follows the session's effective gear, and is the default. The
 * others name a gear for this delegate's calls only — they cannot widen its
 * tool set, cross a deny rule, or turn a parent `plan` session into `agent`.
 */
export type SubagentPermission = 'inherit' | PermissionGear;

export const SUBAGENT_PERMISSIONS: readonly SubagentPermission[] = [
  'inherit',
  'ask',
  'accept-edits',
  'auto',
];
export const DEFAULT_SUBAGENT_PERMISSION: SubagentPermission = 'inherit';

export interface SubagentDefinition {
  /** Delegate id, used as the `Task` argument. */
  name: string;
  /** One line telling the parent model when to delegate here. */
  description: string;
  /** Tools the delegate may call, in canonical (capitalised) spelling. */
  tools: readonly string[];
  /** Provider/model this definition pins, when it pins one. */
  model?: SubagentModelPin;
  /** Reasoning level, clamped against the resolved model at run time. */
  thinkingLevel?: SubagentThinkingLevel;
  permission?: SubagentPermission;
  /** Hard cap on delegate turns. Absent means unlimited. */
  maxTurns?: number;
  /** Parsed for compatibility; arms no timer (see the module note). */
  idleTimeoutSeconds: number;
  /** Parsed for compatibility; arms no timer (see the module note). */
  maxDurationSeconds: number;
  /** Markdown body, used as the delegate's system prompt. */
  prompt: string;
  source: SubagentDefinitionSource;
  /** Absolute path of a user-owned document. */
  filePath?: string;
}

/** pi's reasoning levels, spelled as the loop's `thinkingLevel` expects. */
export const SUBAGENT_THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

/**
 * Tools a definition may declare, in canonical spelling.
 *
 * Plugin, MCP, skill, mode and meta tools stay out of reach on purpose: a
 * delegate is a bounded file/search/shell worker, not a second full session.
 * `Task*` is absent, so a delegate cannot nest another delegation.
 */
export const SUBAGENT_ASSIGNABLE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'BrowserPreview',
  'Bash',
  'Edit',
  'Write',
] as const;

export type SubagentAssignableTool = (typeof SUBAGENT_ASSIGNABLE_TOOLS)[number];

/** Declaring one of these makes a delegate write-capable. */
export const SUBAGENT_MUTATING_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write'];

/** What a definition gets when it says nothing about tools: read-only. */
export const DEFAULT_SUBAGENT_TOOLS: readonly SubagentAssignableTool[] = ['Read', 'Glob', 'Grep'];

/**
 * Canonical name to this runtime's registry name.
 *
 * The one place the capitalisation difference is resolved. Returns undefined
 * for a tool this runtime has no implementation for, which today means
 * `BrowserPreview`; callers intersect against the live registry anyway, so an
 * unknown name narrows the delegate's tool set rather than failing the parse.
 */
export function runtimeToolName(canonical: string): string | undefined {
  const mapped: Record<string, string> = {
    Read: 'read',
    Glob: 'glob',
    Grep: 'grep',
    Bash: 'bash',
    Edit: 'edit',
    Write: 'write',
    // P5-2-3. Registered only when the host supplies a preview surface, so a
    // definition that declares it on a host without one still parses and still
    // round-trips; the tool simply drops out of the intersection and `Task`
    // names it in `unavailableTools`.
    BrowserPreview: 'browser_preview',
  };
  return mapped[canonical];
}

/** Whether this delegate can change the workspace. */
export function subagentCanMutate(definition: SubagentDefinition): boolean {
  return definition.tools.some((tool) => SUBAGENT_MUTATING_TOOLS.includes(tool));
}

export const MAX_SUBAGENT_MAX_TURNS = 80;
/**
 * Parsed-for-compatibility watchdog bounds. No timer reads them (see the
 * module note); they exist so an old document's clamping warning is unchanged.
 */
export const DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS = 300;
export const MIN_SUBAGENT_IDLE_TIMEOUT_SECONDS = 10;
export const MAX_SUBAGENT_IDLE_TIMEOUT_SECONDS = 21_600;
export const DEFAULT_SUBAGENT_MAX_DURATION_SECONDS = 21_600;
export const MIN_SUBAGENT_MAX_DURATION_SECONDS = 60;
export const MAX_SUBAGENT_MAX_DURATION_SECONDS = 21_600;

/**
 * Caps that keep delegation cheap and predictable.
 *
 * The runtime cap and the management cap are deliberately different numbers:
 * 16 is how many a model can still reason about in one tool description, 64 is
 * how many documents a user may keep on disk. Enabling a 65th is a management
 * error; having 17 active is a catalog that silently drops the tail, so it gets
 * a diagnostic instead.
 */
export const MAX_SUBAGENT_DEFINITIONS = 16;
export const MAX_MANAGED_SUBAGENT_DEFINITIONS = 64;
/**
 * Distinct pinned providers. The reference capped this because each one was a
 * live client in its sidecar; our model adapter has the whole catalog bound
 * already, so the cost here is smaller — but the cap is kept so a definition
 * set that works in the reference behaves identically here, and so a document
 * pile cannot turn one delegation menu into a provider sprawl.
 */
export const MAX_SUBAGENT_PROVIDERS = 8;
/** Single document size. Anything larger is a prompt, not a definition. */
export const MAX_SUBAGENT_DOCUMENT_BYTES = 32 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_SUBAGENT_NAME_CHARS = 40;
export const MAX_SUBAGENT_DESCRIPTION_CHARS = 400;

export function isSubagentPermission(value: unknown): value is SubagentPermission {
  return typeof value === 'string' && (SUBAGENT_PERMISSIONS as readonly string[]).includes(value);
}

/** Match a declared tool against the canonical list, ignoring casing. */
export function canonicalToolName(value: unknown): SubagentAssignableTool | undefined {
  if (typeof value !== 'string') return undefined;
  const wanted = value.trim().toLowerCase();
  return SUBAGENT_ASSIGNABLE_TOOLS.find((tool) => tool.toLowerCase() === wanted);
}

/** Filename (or frontmatter `name`) to definition id. */
export function normalizeSubagentName(value: string): string {
  const basename = value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  return (basename ?? '')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export type SubagentParseResult =
  | { ok: true; definition: SubagentDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

type Frontmatter = Map<string, string | string[]>;

/** `max-turns`, `max_turns` and `maxTurns` all land on the same field. */
function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    // subagent-data-07 — the writer escapes an embedded `'` by doubling it, the
    // way a YAML single-quoted scalar does, so the reader has to undo it. While
    // it did not, a description holding a quote grew one more quote on every
    // save: the user's text was rewritten by the act of storing it.
    if (first === "'" && last === "'") return trimmed.slice(1, -1).replace(/''/g, "'");
    if (first === '"' && last === '"') return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Read the leading `---` block.
 *
 * Only the flat subset definitions use: `key: value` scalars, and lists written
 * inline (`[a, b]` / `a, b`) or as following `- item` lines. Deliberately not a
 * YAML parser, for the same reason the skills loader is not one — a real YAML
 * dependency would add its failure modes to the path that builds a system
 * prompt, to read six scalars.
 */
function splitFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  // subagent-data-15 — the leading U+FEFF goes first. The runtime reads these
  // documents through a `TextDecoder`, which strips a BOM; Main reads them with
  // `readFile(path, 'utf8')`, which does not. Without this line the same file
  // written by Windows Notepad loads in a session and is reported as broken on
  // the settings page, and the user is told to repair a definition that works.
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const frontmatter: Frontmatter = new Map();
  if (!normalized.startsWith('---\n')) return { frontmatter, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter, body: normalized.trim() };
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^[ \t]*\n/, '');

  let lastKey: string | null = null;
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
    if (item && lastKey) {
      const existing = frontmatter.get(lastKey);
      const list = Array.isArray(existing) ? existing : [];
      const value = unquote(item[1]);
      if (value) list.push(value);
      frontmatter.set(lastKey, list);
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/);
    if (!pair) continue;
    lastKey = normalizeKey(pair[1]);
    const value = pair[2].trim();
    // An empty scalar opens a block list; the `- item` branch fills it in.
    frontmatter.set(lastKey, value ? unquote(value) : []);
  }
  return { frontmatter, body: body.trim() };
}

function asScalar(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Parse one definition document.
 *
 * `fallbackName` is the filename stem: a document may omit `name`, and the file
 * it lives in is a better identity than a parse failure. `description` is
 * required — without it the parent model cannot decide when to delegate.
 */
export function parseSubagentDefinition(
  raw: string,
  options: { source: SubagentDefinitionSource; fallbackName?: string; filePath?: string }
): SubagentParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { frontmatter, body } = splitFrontmatter(raw);

  const declaredName = asScalar(frontmatter.get('name'));
  const name = normalizeSubagentName(declaredName ?? options.fallbackName ?? '');
  if (!name) errors.push('missing `name` and no filename to fall back on');
  else if (!NAME_RE.test(name)) {
    errors.push(
      `invalid name "${name}": use lowercase letters, digits and dashes (max ${MAX_SUBAGENT_NAME_CHARS} chars)`
    );
  }

  const description = asScalar(frontmatter.get('description'))?.trim() ?? '';
  if (!description) errors.push('missing `description`');
  else if (description.length > MAX_SUBAGENT_DESCRIPTION_CHARS) {
    warnings.push(
      `truncating \`description\` to ${MAX_SUBAGENT_DESCRIPTION_CHARS} characters (it costs prompt tokens on every turn)`
    );
  }

  const declaredTools = asList(frontmatter.get('tools'));
  let tools: string[];
  if (declaredTools.length === 0) {
    tools = [...DEFAULT_SUBAGENT_TOOLS];
  } else if (declaredTools.length === 1 && declaredTools[0] === '*') {
    tools = [...SUBAGENT_ASSIGNABLE_TOOLS];
  } else {
    const accepted: string[] = [];
    for (const declared of declaredTools) {
      const canonical = canonicalToolName(declared);
      if (canonical) {
        if (!accepted.includes(canonical)) accepted.push(canonical);
      } else {
        warnings.push(`ignoring unknown tool "${declared}"`);
      }
    }
    if (accepted.length === 0) {
      errors.push('`tools` lists no usable tool');
      tools = [...DEFAULT_SUBAGENT_TOOLS];
    } else {
      tools = accepted;
    }
  }

  const model = parseModelPin(frontmatter, errors);

  const declaredThinking = asScalar(frontmatter.get('thinkinglevel'));
  let thinkingLevel: SubagentThinkingLevel | undefined;
  if (declaredThinking) {
    const candidate = declaredThinking.trim().toLowerCase();
    if ((SUBAGENT_THINKING_LEVELS as readonly string[]).includes(candidate)) {
      thinkingLevel = candidate as SubagentThinkingLevel;
    } else {
      warnings.push(`ignoring unknown thinking level "${declaredThinking}"`);
    }
  }

  const declaredPermission = asScalar(frontmatter.get('permission'))?.trim();
  let permission: SubagentPermission | undefined;
  if (declaredPermission) {
    const candidate = declaredPermission.toLowerCase();
    if (!isSubagentPermission(candidate)) {
      warnings.push(
        `ignoring unknown permission "${declaredPermission}" (use inherit, ask, accept-edits or auto)`
      );
    } else if (candidate !== DEFAULT_SUBAGENT_PERMISSION) {
      permission = candidate;
    }
  }

  const maxTurns = parseMaxTurns(asScalar(frontmatter.get('maxturns')), warnings);
  const idleTimeoutSeconds = parseTimeoutSeconds(
    asScalar(frontmatter.get('idletimeout')) ?? asScalar(frontmatter.get('idletimeoutseconds')),
    'idle-timeout',
    DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    MIN_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    MAX_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    warnings
  );
  const maxDurationSeconds = parseTimeoutSeconds(
    asScalar(frontmatter.get('maxduration')) ?? asScalar(frontmatter.get('maxdurationseconds')),
    'max-duration',
    DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
    MIN_SUBAGENT_MAX_DURATION_SECONDS,
    MAX_SUBAGENT_MAX_DURATION_SECONDS,
    warnings
  );

  const prompt = body.trim();
  if (!prompt) errors.push('document body is empty (nothing to instruct)');

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    definition: {
      name,
      description: description.slice(0, MAX_SUBAGENT_DESCRIPTION_CHARS),
      tools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(permission ? { permission } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      idleTimeoutSeconds,
      maxDurationSeconds,
      prompt,
      source: options.source,
      ...(options.filePath ? { filePath: options.filePath } : {}),
    },
    warnings,
  };
}

/**
 * `model: <provider>/<model>` is the compact spelling; `provider:` plus
 * `model:` is the explicit one. A model id can itself contain slashes
 * (openrouter style), so only the first segment is the provider.
 */
function parseModelPin(frontmatter: Frontmatter, errors: string[]): SubagentModelPin | undefined {
  const declaredProvider = asScalar(frontmatter.get('provider'))?.trim();
  const declaredModel = asScalar(frontmatter.get('model'))?.trim();
  if (!declaredProvider && !declaredModel) return undefined;
  if (!declaredModel) {
    errors.push('`provider` given without `model`');
    return undefined;
  }
  if (declaredProvider) return { provider: declaredProvider, modelId: declaredModel };
  const slash = declaredModel.indexOf('/');
  if (slash <= 0 || slash === declaredModel.length - 1) {
    errors.push(
      `\`model\` must be "<provider>/<model>" or paired with \`provider\` (got "${declaredModel}")`
    );
    return undefined;
  }
  return { provider: declaredModel.slice(0, slash), modelId: declaredModel.slice(slash + 1) };
}

/** Absent, `none` and `0` all mean unlimited; a positive integer is clamped. */
function parseMaxTurns(value: string | undefined, warnings: string[]): number | undefined {
  if (!value || value.trim().toLowerCase() === 'none') return undefined;
  const parsed = Number(value);
  if (parsed === 0) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnings.push(`ignoring invalid \`maxTurns\` "${value}" (unlimited)`);
    return undefined;
  }
  if (parsed > MAX_SUBAGENT_MAX_TURNS) {
    warnings.push(`clamping \`maxTurns\` ${parsed} to ${MAX_SUBAGENT_MAX_TURNS}`);
    return MAX_SUBAGENT_MAX_TURNS;
  }
  return parsed;
}

function parseTimeoutSeconds(
  value: string | undefined,
  key: 'idle-timeout' | 'max-duration',
  fallback: number,
  minimum: number,
  maximum: number,
  warnings: string[]
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed)) {
    warnings.push(`ignoring invalid \`${key}\` "${value}" (using ${fallback})`);
    return fallback;
  }
  const clamped = Math.min(maximum, Math.max(minimum, parsed));
  if (clamped !== parsed) warnings.push(`clamping \`${key}\` ${parsed} to ${clamped}`);
  return clamped;
}

/** Fields a document can carry. The writer emits them in this order. */
type WritableField =
  | 'name'
  | 'description'
  | 'tools'
  | 'model'
  | 'thinkingLevel'
  | 'permission'
  | 'maxTurns';

/**
 * Quote a scalar only when leaving it bare would change what the parser reads.
 *
 * A description ending in a colon, starting with a bracket, or wrapped in
 * quotes the user typed themselves are the three cases; everything else stays
 * as the user wrote it, because a management UI that re-quoted every
 * description would make its own diff noise on every save.
 */
function writeScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "''";
  const needsQuotes =
    /^[[\-#'"]/.test(trimmed) || /:\s*$/.test(trimmed) || /\n/.test(trimmed) || trimmed !== value;
  if (!needsQuotes) return trimmed;
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Render a definition back to a document.
 *
 * The round trip this has to survive is the contract's, and it is not about
 * formatting: "保存需往返保留所有可执行语义字段；UI 尚无某字段控件时也必须保留原值".
 * So the writer takes the whole parsed definition and emits every executable
 * field it holds — a management UI that only knows about four of them still
 * saves all seven, because it hands back the definition it was given with its
 * four changed.
 *
 * What is deliberately NOT written:
 *
 * - `idleTimeout` / `maxDuration`, which arm nothing (see the module note).
 *   Writing them back would preserve a value that does not act, and make the
 *   document look like it controls a lifetime it does not.
 * - `enabled`. Enablement is this install's state, kept in app data; a document
 *   is a shareable artifact and must not carry one machine's switches.
 * - `permission: inherit`, which is the default. Absent and `inherit` mean the
 *   same thing, and the shorter one does not invite a reader to wonder.
 */
export function formatSubagentDefinition(
  definition: Pick<SubagentDefinition, WritableField | 'prompt'>
): string {
  const lines = ['---', `name: ${definition.name}`];
  lines.push(`description: ${writeScalar(definition.description)}`);
  if (definition.tools.length) lines.push(`tools: [${definition.tools.join(', ')}]`);
  if (definition.model) lines.push(`model: ${subagentModelKey(definition.model)}`);
  if (definition.thinkingLevel) lines.push(`thinkingLevel: ${definition.thinkingLevel}`);
  if (definition.permission && definition.permission !== DEFAULT_SUBAGENT_PERMISSION) {
    lines.push(`permission: ${definition.permission}`);
  }
  // `maxTurns` absent means unlimited, and so does `none`. The explicit word is
  // written because a UI that cleared the cap should leave a document that says
  // so, rather than one where the line silently disappeared.
  if (definition.maxTurns !== undefined) lines.push(`maxTurns: ${definition.maxTurns}`);
  lines.push('---', '', definition.prompt.trim(), '');
  return lines.join('\n');
}

/**
 * Merge discovered definitions into the list the runtime offers.
 *
 * Precedence is user > builtin, so a user document retunes a builtin without
 * renaming it. Past {@link MAX_SUBAGENT_DEFINITIONS} the catalog stops being a
 * menu the model can reason about and every extra entry costs prompt tokens on
 * every turn, so the tail is dropped — with a diagnostic, never silently.
 */
export function mergeSubagentDefinitions(definitions: readonly SubagentDefinition[]): {
  definitions: SubagentDefinition[];
  dropped: string[];
} {
  const byName = new Map<string, SubagentDefinition>();
  // Highest-precedence source first, so the first entry for a name wins it.
  const ordered = [
    ...definitions.filter((definition) => definition.source === 'user'),
    ...definitions.filter((definition) => definition.source === 'builtin'),
  ];
  const dropped: string[] = [];
  for (const definition of ordered) {
    if (byName.has(definition.name)) continue;
    if (byName.size >= MAX_SUBAGENT_DEFINITIONS) {
      dropped.push(definition.name);
      continue;
    }
    byName.set(definition.name, definition);
  }
  return { definitions: [...byName.values()], dropped };
}

/** Stable key for one pin: the same spelling `Task.model` accepts. */
export function subagentModelKey(pin: SubagentModelPin): string {
  return `${pin.provider}/${pin.modelId}`;
}

/** Distinct providers pinned across a definition list, capped. */
export function subagentPinnedProviders(definitions: readonly SubagentDefinition[]): string[] {
  const providers: string[] = [];
  for (const definition of definitions) {
    const provider = definition.model?.provider;
    if (!provider || providers.includes(provider)) continue;
    if (providers.length >= MAX_SUBAGENT_PROVIDERS) break;
    providers.push(provider);
  }
  return providers;
}
