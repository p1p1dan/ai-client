import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexCredentialMode } from './agentSupport.ts';

/**
 * The app-private CODEX_HOME.
 *
 * ## Why this file is not `mkdir -p <empty dir>`
 *
 * The slice-2 brief said "isolated CODEX_HOME" and nothing else. Taken
 * literally that is unimplementable, and both independent design tracks landed
 * on the same finding (arbitration doc §1, convergence item 1): an empty home
 * has no `auth.json` (S1 [实测]: codex needs no `authenticate` call because the
 * credential comes from `~/.codex/auth.json`) and no `model_provider` /
 * `base_url` (this machine talks to a third-party proxy). Every turn would fail,
 * and the failure looks exactly like "the direct integration is wrong".
 *
 * The recipe that actually ran is the one in the S2 probe header
 * (`spikes/s2-codex-question-probe.ts:82-86`): "keeps model_provider / base_url
 * / model / auth.json and drops everything else".
 *
 * ## Why isolate at all
 *
 * The real `~/.codex/config.toml` carries things we must NOT inherit:
 *  - `developer_instructions` — S1 §6.2 C5 [实测]: three wasted runs where the
 *    model said "sure, I will do that" and emitted zero tool calls, because the
 *    user's instructions tell it never to touch code without permission.
 *  - `approval_policy` / `sandbox_mode` — [实测] `danger-full-access` on this
 *    machine. Inheriting it silently disables every approval prompt we are
 *    building slice 4 to show. The user's values are still dropped; ours are
 *    now written in their place (see "The posture is WRITTEN here" below).
 *  - `mcp_servers` / `notify` / `profiles` / `projects` / `history` — extra
 *    processes, extra egress, and a history store we do not control.
 *
 * ## Deny-by-default, single-line-only
 *
 * `config.toml` is WRITTEN BY US, never copied wholesale. Only the root keys in
 * `CODEX_CONFIG_ROOT_ALLOWLIST` and anything under `model_providers.` survives;
 * everything else is dropped, including keys nobody has invented yet.
 *
 * ## The posture is WRITTEN here, not only dropped (S3 slice 5b, H9 layer 1)
 *
 * `approval_policy` / `sandbox_mode` used to be dropped and nothing more, on the
 * reasoning that AiClient states the posture itself in `thread/start`. Resume
 * falsified that: `thread/resume` RE-DERIVES the posture from this file. A thread
 * that had started under `never` / `read-only` came back as
 * `on-request` / `dangerFullAccess` — the real `~/.codex/config.toml`'s values —
 * the moment a fresh process resumed it
 * [实测 `__tests__/fixtures/codex/README.md` 「S5 追加捕获」判决 4]. A projection
 * that only drops therefore hands every resumed session whatever posture the
 * isolated home happens to fall back to, which is the opposite of isolating it.
 *
 * So both keys are now WRITTEN, from the posture the caller passes in — the same
 * object `codexRuntime` puts in `thread/start` (`CODEX_PERMISSION_DEFAULT`).
 * Passed in, never imported: `codexRuntime` imports THIS module, so the reverse
 * edge would be an import cycle. There is deliberately NO default parameter — a
 * defaulted posture would be a second source of truth, and two sources drift in
 * the one direction nobody audits (weaker).
 *
 * CAVEAT, this file is SHARED PERSISTENT state (spec m18): one `config.toml`
 * backs every Codex session, and `ensureCodexHome` rewrites it whenever the bytes
 * would change. Changing the constant therefore RE-POSTURES OLD THREADS on their
 * next resume — a thread created under `workspace-write` resumes under whatever
 * the constant says today. Deliberate (a resumed thread must never run weaker
 * than the current build promises) but not versioned: a per-thread posture would
 * need a mechanism other than this file.
 *
 * Multi-line values are dropped unconditionally. That rule is constructive
 * safety, not laziness: a line-by-line filter over
 * `developer_instructions = """…"""` keeps the assignment out but happily emits
 * the CONTINUATION lines, and a continuation line reading `model = "…"` would
 * then be re-parsed as a root assignment. Refusing multi-line values means the
 * worst case is a missing provider key — which fails loudly on the next turn —
 * instead of a silent downgrade of the security posture.
 *
 * ## Who cleans this directory up: NOBODY
 *
 * There is deliberately no reaper, and adding one later is a data-loss change:
 * this directory holds a COPY OF THE USER'S CREDENTIAL, and from slice 5 onward
 * Codex's own thread history lives here too. Auto-deleting it deletes user
 * history. If a cleanup is ever wanted it must be an explicit, user-initiated
 * action, and it must be reasoned about as "delete credentials + history", not
 * as "clear a cache".
 *
 * ## Logging stance (T-35)
 *
 * Callers get PATHS and KEY NAMES only. No file content ever reaches a log line
 * from here — not the projected TOML, not a `base_url`, and obviously not
 * `auth.json`, which this module copies with `copyFileSync` precisely so the
 * credential never passes through our process memory.
 *
 * The isolated home path itself is injected by Main (`AICLIENT_CODEX_HOME` =
 * `<userData>/codex-home`); the Host cannot compute `userData` and deliberately
 * has NO fallback default here — a missing path is an `agent_unsupported`
 * decision for the caller, not a guess (S2 §附3: one default literal per repo).
 */

/** Root keys carried over verbatim. Exact match — `model_reasoning_effort` is NOT one of them. */
export const CODEX_CONFIG_ROOT_ALLOWLIST: readonly ['model', 'model_provider'] = [
  'model',
  'model_provider',
] as const;

/**
 * Table prefixes carried over. `model_providers.<id>.<key>` is where `base_url`,
 * `wire_api` and `env_key` live, i.e. everything that makes a third-party proxy
 * reachable.
 */
export const CODEX_CONFIG_TABLE_ALLOWLIST: readonly ['model_providers'] = [
  'model_providers',
] as const;

/** Prepended to every generated config so a human editing it learns it is futile. */
export const CODEX_CONFIG_HEADER = [
  '# GENERATED FILE — DO NOT EDIT.',
  '# Written by AiClient (src/agent-host/codexHome.ts) when a Codex session starts.',
  '# Your edits are overwritten on the next start.',
  '#',
  '# This is a deny-by-default projection of your own Codex config: only',
  '#   model, model_provider, model_providers.*',
  '# are carried over. Everything else is dropped on purpose — notably',
  '# developer_instructions, mcp_servers, notify, profiles, projects and history.',
  '#',
  '# The approval_policy / sandbox_mode below are NOT yours: they are the posture',
  '# AiClient runs Codex sessions under, written here because resuming a thread',
  '# re-derives the posture from this file instead of from the parameters the',
  '# session originally started with. Your own values were dropped with the rest.',
  '#',
  '# To change what Codex sees here, edit your real config (CODEX_HOME or',
  '# ~/.codex/config.toml) and restart the session.',
].join('\n');

/**
 * The two config keys the projection ENFORCES, and the posture field each one
 * carries. Exported so the assertion that they are present can name them without
 * respelling the TOML — a test that hard-codes `'approval_policy'` still passes
 * after a rename here, which is exactly the drift H9 exists to catch.
 */
export const CODEX_PERMISSION_CONFIG_KEYS = {
  approvalPolicy: 'approval_policy',
  sandboxMode: 'sandbox_mode',
} as const;

/**
 * The posture, structurally. Deliberately NOT `CodexSessionPermissionPolicy`
 * (that type lives in `codexRuntime.ts`, which imports this module — importing
 * it back would be a cycle) and deliberately not widened with `networkAccess`:
 * that field is a server default we merely record, never a config key.
 */
export interface CodexHomePermissionPosture {
  approvalPolicy: string;
  sandboxMode: string;
}

/**
 * The enforced lines, rendered as root assignments.
 *
 * `JSON.stringify` and not manual quoting: a TOML basic string and a JSON string
 * escape the same way, so a posture value containing a quote or a backslash
 * cannot produce a config file codex refuses to parse (which would fail EVERY
 * session, not just this key).
 */
function renderPermissionPosture(permission: CodexHomePermissionPosture): string[] {
  return [
    `${CODEX_PERMISSION_CONFIG_KEYS.approvalPolicy} = ${JSON.stringify(permission.approvalPolicy)}`,
    `${CODEX_PERMISSION_CONFIG_KEYS.sandboxMode} = ${JSON.stringify(permission.sandboxMode)}`,
  ];
}

export interface CodexConfigProjection {
  /** The generated `config.toml` text, header included. Always ends with a newline. */
  toml: string;
  /** Fully-qualified paths of kept keys, first-seen order, de-duplicated. For logs. */
  kept: string[];
  /**
   * Fully-qualified paths of dropped keys, first-seen order, de-duplicated.
   * A rejected TABLE is recorded once by its own path (`mcp_servers.filesystem`)
   * rather than once per key inside it — the table is the reason, and per-key
   * noise would bury it in the log line.
   */
  dropped: string[];
}

/** The bits of `node:fs` this module touches. Injected so tests never touch a real disk. */
export interface CodexHomeFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options: { mode: number }): void;
  copyFileSync(source: string, destination: string): void;
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { mtimeMs: number };
  /** D47 S4a — the managed branch's only destructive call (stale `auth.json` cleanup). */
  unlinkSync(path: string): void;
}

/**
 * D47 S4a (rev.2 architecture pick) — judgement-discriminated by `mode`,
 * replacing the old single shape that only ever described the fallback
 * (projecting) branch. `'projected'` is the fallback branch, unchanged in
 * every field (A 轨 M9: `projection`/`authCopied` are real audit data, never
 * an empty array standing in for "we did not actually project anything").
 * `'managed'` carries no projection audit at all — this branch never reads or
 * writes `config.toml`, so there is nothing truthful to report under those
 * keys.
 */
export type EnsureCodexHomeResult =
  | { mode: 'projected'; homeDir: string; projection: CodexConfigProjection; authCopied: boolean }
  | { mode: 'managed'; homeDir: string };

/** `auth.json` and the generated config are created owner-only. */
const CREDENTIAL_MODE = 0o600;

const CONFIG_BASENAME = 'config.toml';
const AUTH_BASENAME = 'auth.json';

const TRIPLE_BASIC = '"""';
const TRIPLE_LITERAL = "'''";

type Skip =
  | { kind: 'multiline-string'; delimiter: string }
  | { kind: 'bracket'; depth: number }
  | null;

type ValueScan =
  | { kind: 'single'; text: string }
  | { kind: 'multiline-string'; delimiter: string }
  | { kind: 'bracket'; depth: number }
  | { kind: 'reject' };

/**
 * Index of the closing quote of the string starting at `start`, or -1 if the
 * line ends first. Basic strings honour backslash escapes; literal strings
 * (`'…'`) have none by TOML rule.
 */
function findStringEnd(line: string, start: number): number {
  const quote = line[start];
  const escapes = quote === '"';
  for (let i = start + 1; i < line.length; i += 1) {
    const ch = line[i];
    if (escapes && ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

/**
 * Classify the value half of an assignment.
 *
 * Any triple-quoted value is rejected outright, even when it opens and closes on
 * one line: triple quotes exist to hold prose, and prose is the one thing this
 * projection must never carry (see the `developer_instructions` history above).
 * Unbalanced `[`/`{` means the value continues on the next line, so the caller
 * enters skip mode instead of parsing those lines as assignments.
 */
function scanValue(raw: string): ValueScan {
  let depth = 0;
  let end = raw.length;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '#') {
      end = i;
      break;
    }
    if (raw.startsWith(TRIPLE_BASIC, i) || raw.startsWith(TRIPLE_LITERAL, i)) {
      const delimiter = raw.startsWith(TRIPLE_BASIC, i) ? TRIPLE_BASIC : TRIPLE_LITERAL;
      const closed = raw.indexOf(delimiter, i + delimiter.length) !== -1;
      return closed ? { kind: 'reject' } : { kind: 'multiline-string', delimiter };
    }
    if (ch === '"' || ch === "'") {
      const stringEnd = findStringEnd(raw, i);
      // Unterminated single-quoted string: invalid TOML. Drop the key and keep
      // reading normally — there is no legal continuation to skip.
      if (stringEnd === -1) return { kind: 'reject' };
      i = stringEnd + 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) return { kind: 'reject' };
    }
    i += 1;
  }
  if (depth > 0) return { kind: 'bracket', depth };
  const text = raw.slice(0, end).trim();
  return text.length === 0 ? { kind: 'reject' } : { kind: 'single', text };
}

/**
 * Continue a multi-line array/inline-table scan on a following line.
 *
 * A triple quote encountered mid-array stops the scan for this line WITHOUT
 * decrementing anything, so we stay in skip mode longer rather than shorter.
 * Erring long drops keys; erring short would emit a continuation line.
 */
function continueBracketScan(line: string, depth: number): number {
  let next = depth;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '#') break;
    if (line.startsWith(TRIPLE_BASIC, i) || line.startsWith(TRIPLE_LITERAL, i)) break;
    if (ch === '"' || ch === "'") {
      const stringEnd = findStringEnd(line, i);
      if (stringEnd === -1) break;
      i = stringEnd + 1;
      continue;
    }
    if (ch === '[' || ch === '{') next += 1;
    else if (ch === ']' || ch === '}') next -= 1;
    if (next <= 0) return 0;
    i += 1;
  }
  return next;
}

/** Split a bare/quoted dotted key or table name into segments. `null` = malformed. */
function splitDottedKey(raw: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let sawQuoted = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '"' || ch === "'") {
      const end = findStringEnd(raw, i);
      if (end === -1) return null;
      current += raw.slice(i + 1, end);
      sawQuoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '.') {
      const segment = sawQuoted ? current : current.trim();
      if (segment.length === 0) return null;
      segments.push(segment);
      current = '';
      sawQuoted = false;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const last = sawQuoted ? current : current.trim();
  if (last.length === 0) return null;
  segments.push(last);
  return segments;
}

/** First `=` that is not inside a quoted key segment. */
function findAssignmentEquals(line: string): number {
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '"' || ch === "'") {
      const end = findStringEnd(line, i);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '=') return i;
    i += 1;
  }
  return -1;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatSegment(segment: string): string {
  return BARE_KEY.test(segment) ? segment : JSON.stringify(segment);
}

function formatPath(segments: readonly string[]): string {
  return segments.map(formatSegment).join('.');
}

/** Deny-by-default: root keys by exact match, everything else only under an allowed table. */
function isAllowedPath(segments: readonly string[]): boolean {
  const head = segments[0];
  if (head === undefined) return false;
  if (segments.length === 1)
    return (CODEX_CONFIG_ROOT_ALLOWLIST as readonly string[]).includes(head);
  return (CODEX_CONFIG_TABLE_ALLOWLIST as readonly string[]).includes(head);
}

interface KeptEntry {
  segments: string[];
  value: string;
}

function renderToml(entries: readonly KeptEntry[], permission: CodexHomePermissionPosture): string {
  // FIRST, and above every projected key: they are root assignments, and TOML
  // reads a root assignment that follows a `[table]` header as a member of that
  // table. Emitting the posture last would silently move it under
  // `[model_providers.…]`, where codex would never read it as a posture at all.
  const lines: string[] = [CODEX_CONFIG_HEADER, '', ...renderPermissionPosture(permission), ''];
  const rootEntries = entries.filter((entry) => entry.segments.length === 1);
  for (const entry of rootEntries) {
    lines.push(`${formatSegment(entry.segments[0] as string)} = ${entry.value}`);
  }
  if (rootEntries.length > 0) lines.push('');

  // Table order = first-seen order, so a diff of two generated configs tracks a
  // diff of the sources instead of hash order.
  const tables = new Map<string, KeptEntry[]>();
  for (const entry of entries) {
    if (entry.segments.length < 2) continue;
    const table = formatPath(entry.segments.slice(0, -1));
    const bucket = tables.get(table);
    if (bucket) bucket.push(entry);
    else tables.set(table, [entry]);
  }
  for (const [table, bucket] of tables) {
    lines.push(`[${table}]`);
    for (const entry of bucket) {
      lines.push(
        `${formatSegment(entry.segments[entry.segments.length - 1] as string)} = ${entry.value}`
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Pure projection: source TOML text + the posture to enforce in, generated TOML
 * text + audit lists out. No fs, no env, no clock — the whole security decision
 * of this feature is one string→string function so it can be tested
 * exhaustively.
 *
 * `permission` is required and never lands in `kept`: `kept` / `dropped` audit
 * what happened to the USER'S keys, and their `approval_policy` / `sandbox_mode`
 * are still DROPPED (they appear in `dropped`, as before). Recording our own two
 * lines as "kept" would report that the user's posture survived.
 */
export function projectCodexConfig(
  sourceToml: string,
  permission: CodexHomePermissionPosture
): CodexConfigProjection {
  const entries: KeptEntry[] = [];
  const kept = new Set<string>();
  const dropped = new Set<string>();

  // `null` = root scope. `tableAllowed:false` means the current table was
  // rejected as a whole; its keys are still SCANNED (skip state must stay
  // correct) but not recorded individually.
  let table: string[] | null = null;
  let tableAllowed = true;
  let skip: Skip = null;

  for (const rawLine of sourceToml.split(/\r?\n/)) {
    if (skip !== null) {
      if (skip.kind === 'multiline-string') {
        if (rawLine.includes(skip.delimiter)) skip = null;
      } else {
        const depth = continueBracketScan(rawLine, skip.depth);
        if (depth <= 0) skip = null;
        else skip = { kind: 'bracket', depth };
      }
      continue;
    }

    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      // Array-of-tables (`[[x]]`) is never allowlisted: nothing under
      // `model_providers` uses it, and deny-by-default owns the unknown case.
      const isArrayTable = line.startsWith('[[');
      const open = isArrayTable ? 2 : 1;
      const close = line.lastIndexOf(isArrayTable ? ']]' : ']');
      const inner = close > open ? line.slice(open, close).trim() : '';
      const segments = inner.length > 0 ? splitDottedKey(inner) : null;
      if (segments === null) {
        // Unparseable header: enter an unnamed, rejected scope. Falling back to
        // ROOT scope here would let the keys under a garbled `[mcp_servers…`
        // header be judged as root keys — deny-by-default must survive garbage.
        table = [];
        tableAllowed = false;
        continue;
      }
      table = segments;
      tableAllowed =
        !isArrayTable &&
        (CODEX_CONFIG_TABLE_ALLOWLIST as readonly string[]).includes(segments[0] as string);
      if (!tableAllowed) dropped.add(formatPath(segments));
      continue;
    }

    const eq = findAssignmentEquals(line);
    if (eq === -1) continue;
    const keySegments = splitDottedKey(line.slice(0, eq));
    const scan = scanValue(line.slice(eq + 1));
    if (scan.kind === 'multiline-string')
      skip = { kind: 'multiline-string', delimiter: scan.delimiter };
    else if (scan.kind === 'bracket') skip = { kind: 'bracket', depth: scan.depth };

    if (keySegments === null) continue;
    const segments = table === null ? keySegments : [...table, ...keySegments];
    const path = formatPath(segments);

    const scopeDropped = table !== null && !tableAllowed;
    if (scopeDropped || !isAllowedPath(segments) || scan.kind !== 'single') {
      // Keys inside an already-reported table are covered by that report.
      if (!scopeDropped) dropped.add(path);
      continue;
    }
    kept.add(path);
    entries.push({ segments, value: scan.text });
  }

  return { toml: renderToml(entries, permission), kept: [...kept], dropped: [...dropped] };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Where the user's real Codex config lives — the SOURCE we project from, never
 * a target we write to. Mirrors codex's own resolution: `CODEX_HOME` wins,
 * otherwise `~/.codex`.
 */
export function resolveSourceCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): string {
  const explicit = trimOrUndefined(env.CODEX_HOME);
  if (explicit !== undefined) return explicit;
  return join(trimOrUndefined(homeDir) ?? homedir(), '.codex');
}

const nodeFs: CodexHomeFs = {
  existsSync: (path) => existsSync(path),
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => {
    writeFileSync(path, data, options);
  },
  copyFileSync: (source, destination) => {
    copyFileSync(source, destination);
  },
  chmodSync: (path, mode) => {
    chmodSync(path, mode);
  },
  statSync: (path) => statSync(path),
  unlinkSync: (path) => {
    unlinkSync(path);
  },
};

function readIfExists(fs: CodexHomeFs, path: string): string | null {
  if (!fs.existsSync(path)) return null;
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function mtimeOrNull(fs: CodexHomeFs, path: string): number | null {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Materialise the isolated home. Idempotent: `mkdir -p`, and the config is only
 * rewritten when its bytes would change, so a per-session call does not churn
 * mtimes or race a running codex.
 *
 * `auth.json` is COPIED, never symlinked — a Windows symlink needs elevation or
 * developer mode, and the failure would only show up on a packaged box we cannot
 * reach from this dev machine. A missing source `auth.json` is NOT an error
 * here: `authCopied:false` lets the caller decide (codex may still succeed via
 * an API-key env var), and throwing would turn a soft "not signed in" into a
 * hard crash.
 *
 * KNOWN AND REGISTERED (arbitration doc §4): this copy is a SECOND ON-DISK COPY
 * of the user's credential, and it goes stale if the user rotates
 * `~/.codex/auth.json`. The mtime check refreshes it on the next session start.
 */
export function ensureCodexHome(input: {
  homeDir: string;
  /**
   * The posture to enforce in the generated config (H9 layer 1). Required, so a
   * new caller cannot materialise a home whose posture nobody chose — see the
   * "no default parameter" note in the module header.
   *
   * Unused in the managed branch (D47 S4a): Main writes `config.toml` there
   * (S3b, `codexManagedConfig.ts`), posture included. Still required on every
   * call — the caller does not know which branch it will take until this
   * function reads {@link resolveCodexCredentialMode}, so there is no call
   * site that could omit it.
   */
  permission: CodexHomePermissionPosture;
  sourceHomeDir?: string;
  fs?: CodexHomeFs;
  log?: (...args: unknown[]) => void;
  /**
   * D47 S4a — test seam for {@link resolveCodexCredentialMode}, one of the
   * resolver's four readers (§1). Defaults to `process.env`, same convention
   * as every other env-reading function in this repo.
   */
  env?: NodeJS.ProcessEnv;
}): EnsureCodexHomeResult {
  const fs = input.fs ?? nodeFs;
  const log = input.log ?? ((...args: unknown[]) => console.error('[codex-home]', ...args));
  const homeDir = input.homeDir.trim();
  if (homeDir.length === 0) {
    // No fallback default, by ruling: Main owns this path (`AICLIENT_CODEX_HOME`
    // = `<userData>/codex-home`). Guessing one here would silently seed a
    // credential copy somewhere nobody looks.
    throw new Error('ensureCodexHome: homeDir is required (Main injects AICLIENT_CODEX_HOME)');
  }

  fs.mkdirSync(homeDir, { recursive: true });

  // D47 S4a (rev.2 architecture pick, B 轨 c): managed mode's `config.toml` is
  // physically OWNED by Main (S3b) — this branch neither projects, copies nor
  // writes it. `managed_missing_credentials` never reaches here in normal
  // operation (the registry gate in `agentSupport.ts` refuses the session
  // before `createSession`/`resumeSession` ever calls this function), so any
  // non-`'fallback'` mode is treated identically: managed.
  if (resolveCodexCredentialMode(input.env).mode !== 'fallback') {
    return ensureManagedCodexHome({ homeDir, fs, log });
  }

  const sourceHomeDir = trimOrUndefined(input.sourceHomeDir) ?? resolveSourceCodexHome();

  const sourceConfigPath = join(sourceHomeDir, CONFIG_BASENAME);
  const targetConfigPath = join(homeDir, CONFIG_BASENAME);
  const projection = projectCodexConfig(readIfExists(fs, sourceConfigPath) ?? '', input.permission);
  if (readIfExists(fs, targetConfigPath) !== projection.toml) {
    fs.writeFileSync(targetConfigPath, projection.toml, { mode: CREDENTIAL_MODE });
  }

  const sourceAuthPath = join(sourceHomeDir, AUTH_BASENAME);
  const targetAuthPath = join(homeDir, AUTH_BASENAME);
  let authCopied = false;
  const sourceAuthMtime = fs.existsSync(sourceAuthPath) ? mtimeOrNull(fs, sourceAuthPath) : null;
  if (sourceAuthMtime === null) {
    log('codex home: source auth.json not found', { sourceAuthPath });
  } else {
    const targetAuthMtime = fs.existsSync(targetAuthPath) ? mtimeOrNull(fs, targetAuthPath) : null;
    if (targetAuthMtime === null || sourceAuthMtime > targetAuthMtime) {
      // copyFileSync, not read+write: the credential never enters this process's
      // memory, so it cannot end up in a heap dump or an error message.
      fs.copyFileSync(sourceAuthPath, targetAuthPath);
      fs.chmodSync(targetAuthPath, CREDENTIAL_MODE);
      authCopied = true;
    }
  }

  // Paths and key NAMES only — never `projection.toml`, never a value. (T-35)
  // `enforced` lists the two posture KEYS, not their values: a log line is not
  // the place to publish the posture, and the values are asserted in tests
  // against the constant instead.
  log('codex home ready', {
    homeDir,
    configPath: targetConfigPath,
    kept: projection.kept,
    dropped: projection.dropped,
    enforced: Object.values(CODEX_PERMISSION_CONFIG_KEYS),
    authCopied,
  });

  return { mode: 'projected', homeDir, projection, authCopied };
}

/**
 * `false` only for the one errno this branch treats as "nothing to do"
 * (ENOENT). Every OTHER unlink failure (EACCES, EPERM, a directory where a
 * file was expected…) propagates as a thrown Error from
 * {@link ensureManagedCodexHome}, which is deliberate: both S4 review tracks
 * independently flagged "delete stale auth.json" as an ACTION the caller must
 * be able to act on (`home_prepare_failed`), not a fact merely logged and
 * ignored (rev.2 §2 S4a, I4).
 */
function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The managed branch (D47 S4a). `config.toml` is Main's to write (S3b); this
 * function's only two jobs are cleanup and an honesty check:
 *
 *  - delete a leftover `auth.json`. A managed session authenticates purely
 *    through `AICLIENT_CODEX_API_KEY` (`codexRuntime.ts`'s spawn env) plus
 *    `config.toml`'s `env_key` indirection (E4 evidence, 2026-08-15) — a STALE
 *    copy left behind by an earlier FALLBACK-mode run in this same `homeDir`
 *    would let codex silently prefer file-based auth over the managed one,
 *    exactly the leak "managed" promises not to have. Idempotent unlink
 *    (ENOENT is the ordinary case — nothing to delete); any OTHER failure now
 *    BLOCKS the session rather than only being logged (see
 *    {@link isEnoentError}).
 *  - verify `config.toml` exists. Main writes it in a separate lifecycle step
 *    (startup phase 3 / login / logout regenerate, S3b); a Host that raced
 *    ahead of that write, or whose Main-side write failed, must refuse
 *    honestly (`home_prepare_failed`, via the thrown Error below) instead of
 *    handing codex a directory with no provider table — which fails
 *    illegibly deep inside the turn loop instead of at the point that
 *    actually knows what is missing.
 *
 * Never touches `config.toml`'s CONTENT either way, so — unlike the fallback
 * branch's `log('codex home ready', …)` — there is nothing here that could
 * leak a projected value even by accident (T-35).
 */
function ensureManagedCodexHome(input: {
  homeDir: string;
  fs: CodexHomeFs;
  log: (...args: unknown[]) => void;
}): EnsureCodexHomeResult {
  const { homeDir, fs, log } = input;
  const authPath = join(homeDir, AUTH_BASENAME);
  try {
    fs.unlinkSync(authPath);
  } catch (err) {
    if (!isEnoentError(err)) {
      throw new Error(
        `ensureCodexHome (managed): could not remove the stale auth.json at ${authPath}: ${errorMessage(err)}`
      );
    }
  }

  const configPath = join(homeDir, CONFIG_BASENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `ensureCodexHome (managed): config.toml not found at ${configPath} — Main should have written it before the Host starts a session`
    );
  }

  log('codex home ready (managed)', { homeDir, configPath, authRemoved: true });

  return { mode: 'managed', homeDir };
}
