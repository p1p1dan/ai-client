/**
 * P2-2 — the project instruction chain that fills the `project-instructions`
 * prompt slot.
 *
 * Provenance (AGENTS.md requires stating it): **adapted** from PI-Desktop's
 * `packages/agent-runtime/src/project-instructions.ts` and
 * `project-instructions-prompt.ts`. The file-name list, the 32 KiB shared
 * budget and the symlink containment guard are theirs and are kept as-is. Four
 * things differ, each noted at the point it appears: global files are a list
 * rather than one hardcoded path, reading goes through a port instead of
 * `node:fs`, the assembled block is returned as a prompt segment rather than a
 * string, and the directory walk follows the official tier rule rather than the
 * reference's unreachable `targetPath` chain.
 *
 * ## Which directories are loaded when (decision 007)
 *
 * The reference walked root→leaf from a `targetPath` the caller supplies, and
 * this module was ported with that walk intact. No caller ever supplied one:
 * the parameter reached `RuntimeRunRequest` and stopped there, in this product
 * and in the reference alike (context-prompt-03). Decision 007 replaced it with
 * the official rule, which has two halves:
 *
 * - **At session start**, the workspace root and every parent directory, least
 *   specific first. {@link instructionDirectories} is that walk. It stops
 *   BEFORE the filesystem root, matching Claude Code's documented "recurses up
 *   to but not including /": a machine-wide `/CLAUDE.md` is not something a
 *   workspace opted into.
 * - **On demand**, a subdirectory's file when a tool reads into that subtree.
 *   That half does not live here — it is session state, so it lives in
 *   `instructionTracker.ts` and reaches the model as an injected message rather
 *   than through the system prompt (each file is loaded exactly once per
 *   session, and rewriting the system prompt mid-run would break the cache
 *   prefix for every later turn).
 *
 * `CLAUDE.local.md` is read from the same directories, ADDED to whichever of
 * {@link INSTRUCTION_FILE_NAMES} that directory contributed rather than
 * replacing it — it is the local, not-checked-in companion to a shared file,
 * and decision 008 puts it behind the `local` setting source.
 *
 * ## The home directory is the user tier (T059)
 *
 * The walk above used to treat `~` like any other parent: a workspace under
 * the home directory read `~/.claude/CLAUDE.md` as a PROJECT file (so
 * `settingSources: ['project']` still loaded the user's personal rules), and a
 * workspace elsewhere never saw it at all. Decision 008 calls that file the
 * `user` source, so it is now loaded as one: once, ahead of the project chain,
 * for every workspace, behind the `user` switch — and never as
 * `CLAUDE.local.md`, which only means something inside a project. The walk
 * skips the home directory itself (already loaded) and everything above it:
 * `/home` and `C:\Users` are shared by every account on the machine and are
 * not something a workspace opted into.
 *
 * The home directory is a parameter ({@link InstructionChainOptions.home})
 * rather than `os.homedir()`, for the same reason reading is a port: this
 * module stays testable against an in-memory tree.
 *
 * ## Why reading is a port
 *
 * ARD D11: every runtime file read goes through `runtimeHostIo`, because the
 * encrypted Windows target serves plaintext per process and a module that
 * calls `node:fs` directly is the per-module compatibility patch D11 exists to
 * prevent. That service is P1-0's, so this module declares the two operations
 * it needs ({@link InstructionSource}) and P2-2's wiring step adapts
 * `runtimeHostIo` to them. The pure consequence is a happy accident: the whole
 * chain is testable against an in-memory source, with no fixture tree on disk.
 */

import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveSettingSources, type SettingSourceOptions } from '../../settingSources.ts';
import type { PromptSegment } from './segments.ts';

/**
 * Per directory, the first name that exists wins. `AGENTS.override.md` first so
 * a checked-in `AGENTS.md` can be overridden locally without editing it;
 * `CLAUDE.md` and `.claude/CLAUDE.md` because this product's users keep both
 * conventions (this repo's own root has a `CLAUDE.md`).
 */
export const INSTRUCTION_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  join('.claude', 'CLAUDE.md'),
] as const;

/**
 * decision 008 — the `local` tier's instruction file.
 *
 * Deliberately NOT a fifth entry in {@link INSTRUCTION_FILE_NAMES}: that list
 * is first-one-wins, and a local file that SUPPRESSED the team's checked-in
 * `AGENTS.md` would be the opposite of what "local additions" means. It is read
 * after the directory's shared file and appended to it.
 */
export const LOCAL_INSTRUCTION_FILE_NAME = 'CLAUDE.local.md';

/**
 * T059 — the home directory's candidates, first one wins, and NOT a superset
 * of {@link INSTRUCTION_FILE_NAMES}: a bare `~/AGENTS.md` or `~/CLAUDE.md` is
 * not looked for. The user asked for exactly this — "if none is there, there is
 * none" — so the tier is empty rather than falling back to a project-style
 * name at the top of the home directory.
 *
 * The order is this product first, then the two conventions its users also
 * keep: `.pilab` is our own root, `.claude` is where Claude Code keeps its user
 * memory, `.codex` is Codex CLI's global directory. Each entry is
 * `<dot-directory>/<file>` and is spelled with `join`, never a `/` literal,
 * because the walk keys files with `join` on the platform separator.
 *
 * `~/.pilab/AGENTS.md` sits directly under `.pilab`, NOT under
 * `~/.pilab/<profile>/` where the rest of this product's per-install state
 * lives. Deliberate: a user's instructions do not differ between a dev and a
 * release install, so they do not belong to a profile.
 */
export const HOME_INSTRUCTION_FILE_NAMES: readonly string[] = [
  join('.pilab', 'AGENTS.md'),
  join('.claude', 'CLAUDE.md'),
  join('.codex', 'AGENTS.md'),
];

/**
 * Safety bound on the parent-directory climb; a real filesystem never gets
 * close. Same guard, and the same reason, as `plugins/skills/index.ts`: a
 * `dirname` that stops shrinking on some exotic path must not spin.
 */
export const MAX_INSTRUCTION_ANCESTORS = 64;

/**
 * decision 007 — the workspace root and every parent, least specific first.
 *
 * Least specific first because the chain is rendered in load order and the
 * prompt block tells the model that a more specific file wins; putting `cwd`
 * last is what makes "more specific" and "later" the same thing.
 *
 * The filesystem root is excluded unless it IS the workspace (Claude Code's
 * documented rule is "up to but not including /"). Excluding it also keeps the
 * walk off a path no workspace ever opted into; including the workspace itself
 * keeps context-prompt-13's "the workspace IS `/`" case working.
 */
export function instructionDirectories(cwd: string): readonly string[] {
  const start = resolve(cwd);
  const chain = [start];
  let directory = start;
  for (let level = 0; level < MAX_INSTRUCTION_ANCESTORS; level++) {
    const parent = dirname(directory);
    // `dirname` is its own fixed point at the filesystem root, so this is both
    // the "reached the top" test and the "parent IS the top" test.
    if (parent === directory || dirname(parent) === parent) break;
    chain.push(parent);
    directory = parent;
  }
  return chain.reverse();
}

/**
 * Total budget across the whole chain, globals included.
 *
 * Shared rather than per-file on purpose: the chain is what lands in the
 * prompt, so a single 500 KiB AGENTS.md must not be able to push everything
 * else out — or, worse, quietly eat the context window the conversation needs.
 */
export const MAX_INSTRUCTION_BYTES = 32 * 1024;

export interface ProjectInstruction {
  /** What the prompt shows as the heading — a workspace-relative path or a label. */
  source: string;
  content: string;
}

/**
 * The file access this module needs, and nothing more.
 *
 * Both operations answer `undefined` instead of throwing for the expected
 * absences (no such file, unreadable, a broken link): a missing AGENTS.md is
 * the normal case, not an error worth unwinding a prompt build for.
 */
export interface InstructionSource {
  readText(path: string): Promise<string | undefined>;
  /** Resolved real path, for the containment guard. `undefined` when it cannot be resolved. */
  realpath(path: string): Promise<string | undefined>;
}

/**
 * A file loaded ahead of the project chain.
 *
 * `scope` exists only because decision 008 splits this list in two: the managed
 * `<agentDir>/AGENTS.md` ships with the app and is never switched off, while a
 * host-supplied `~/.claude/CLAUDE.md` is the `user` setting source and is. An
 * absent `scope` means `user`, so the only call site that has to say anything
 * is the one that supplies the managed file.
 */
export interface InstructionGlobal {
  path: string;
  label: string;
  scope?: 'managed' | 'user';
}

export interface InstructionChainOptions extends SettingSourceOptions {
  /** Workspace root. Absent loads only explicitly supplied global files. */
  root?: string;
  /**
   * T059 — the user's home directory: the `user` tier's instruction file lives
   * there, and the project walk stops below it. Absent means no user tier and
   * an unshortened walk. Supplied by the plugin layer (`os.homedir()` is not
   * called here — see the module header).
   */
  home?: string;
  /**
   * Global instruction files, in the order they should appear, before any
   * project file. A LIST rather than PI-Desktop's single
   * `~/.pi/agent/AGENTS.md`: the agent dir's own file is one source, and a
   * caller may supply others. Neither this module nor its tests should know
   * where any of them live.
   *
   * (It used to name H/17's borrow mechanism as the second source. That is
   * gone — H/19 copies the user's `AGENTS.md` in rather than reading it
   * through — but the list shape is still the right one.)
   */
  globals?: readonly InstructionGlobal[];
  maxBytes?: number;
  /**
   * A-round testing only (temporary, see `flags.ts`'s
   * `SKIP_USER_INSTRUCTIONS_ENV`): when `true`, the user tier (T059 — the
   * home-directory global) is skipped regardless of `sources.user`. Does NOT
   * touch the project or local tiers below; those keep loading the
   * workspace's own `CLAUDE.md` / `AGENTS.md` exactly as before. Left
   * `undefined`/`false` by default, which is the pre-existing behaviour — the
   * actual A-round switch is resolved in `bootstrap.ts`, not here, so this
   * module stays a pure function of its options (same reasoning as `home`
   * above).
   */
  skipUserTier?: boolean;
}

/**
 * Containment, by relative path rather than string prefix.
 *
 * context-prompt-13: `path.startsWith(root + sep)` cannot be true when `root`
 * already ends in a separator, which is what `resolve` returns for a filesystem
 * root (`/`, `C:\`). A workspace opened at one of those had its whole
 * instruction chain silently vanish — including the symlink guard's verdict on
 * a file that was in fact contained. `relative` handles both shapes, and
 * answers `''` for the root itself.
 */
function isWithinRoot(root: string, path: string): boolean {
  if (path === root) return true;
  const offset = relative(root, path);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

/**
 * Same directory, by the platform's own rules rather than string equality:
 * `relative` folds case and separators on Windows (`C:\Users\JC` and
 * `c:/users/jc/` answer `''`) and stays case-sensitive on POSIX.
 */
function sameDirectory(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/** Windows separators normalized so a recorded source path reads the same everywhere. */
function normalizeStablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Truncate to a byte budget without splitting a character.
 *
 * Byte-wise truncation of UTF-8 can end mid-sequence and produce a replacement
 * character in the prompt; iterating by code point costs nothing at these sizes
 * and cannot.
 */
export function limitUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return content.slice(0, end);
}

/**
 * `undefined` when the file is absent, empty, or fails containment — the
 * caller moves on to the next name. `'loaded'` when it is present and contained
 * but already in the prompt: it still wins its directory's one-file slot, so
 * the caller must NOT fall through to the next name, or a directory that was
 * deduplicated would contribute a second file it never contributed before.
 */
async function readInstructionFile(
  source: InstructionSource,
  labelRoot: string,
  directory: string,
  canonicalDirectory: string,
  name: string,
  remaining: number,
  loaded: Set<string> | undefined
): Promise<ProjectInstruction | 'loaded' | undefined> {
  const file = join(directory, name);
  // A symlink pointing out of the directory it was found in would otherwise
  // pull arbitrary files into the prompt, so containment is checked on the
  // resolved path. Checked per directory rather than against the workspace
  // root, because the walk now also visits directories ABOVE the workspace,
  // where "inside the workspace" is not a question that has a useful answer.
  const canonical = await source.realpath(file);
  if (!canonical || !isWithinRoot(canonicalDirectory, canonical)) return undefined;
  // T059 — keyed by real path so the same file reached under two spellings
  // (a global's absolute path, the walk's `join`) is still one file.
  if (loaded?.has(canonical)) return 'loaded';
  const content = (await source.readText(file))?.trim();
  if (!content) return undefined;
  const limited = limitUtf8(content, remaining);
  if (!limited) return undefined;
  loaded?.add(canonical);
  return { source: normalizeStablePath(relative(labelRoot, file) || name), content: limited };
}

/**
 * One directory's contribution: its shared file (first name that exists) plus,
 * when the `local` source is on, its `CLAUDE.local.md`.
 *
 * Exported because the on-demand tier in `instructionTracker.ts` reads exactly
 * the same way — a subdirectory found mid-session must not have different rules
 * from the one that was there at startup.
 *
 * `loaded` is the chain-wide set of real paths already in the prompt (T059):
 * a file in it is skipped, a file read here is added. Optional because the
 * on-demand tier keeps its own per-directory bookkeeping and never meets a
 * global. `names` defaults to the project list; the user tier passes its own.
 */
export async function readDirectoryInstructions(
  source: InstructionSource,
  options: {
    labelRoot: string;
    directory: string;
    remaining: number;
    local: boolean;
    names?: readonly string[];
    loaded?: Set<string>;
  }
): Promise<readonly ProjectInstruction[]> {
  const { labelRoot, directory, loaded } = options;
  let remaining = options.remaining;
  if (remaining <= 0) return [];
  const entries: ProjectInstruction[] = [];
  const canonicalDirectory = (await source.realpath(directory)) ?? directory;
  for (const name of options.names ?? INSTRUCTION_FILE_NAMES) {
    const entry = await readInstructionFile(
      source,
      labelRoot,
      directory,
      canonicalDirectory,
      name,
      remaining,
      loaded
    );
    if (!entry) continue;
    if (entry !== 'loaded') {
      entries.push(entry);
      remaining -= Buffer.byteLength(entry.content, 'utf8');
    }
    break;
  }
  // decision 008 — the local file ADDS to the shared one rather than replacing
  // it, so it is read even when one of the four names already matched.
  if (options.local && remaining > 0) {
    const entry = await readInstructionFile(
      source,
      labelRoot,
      directory,
      canonicalDirectory,
      LOCAL_INSTRUCTION_FILE_NAME,
      remaining,
      loaded
    );
    if (entry && entry !== 'loaded') entries.push(entry);
  }
  return entries;
}

/**
 * Load globals, then the user tier, then the workspace and its parents, sharing
 * one byte budget.
 *
 * Globals go first so a project file, being later, can contradict them; within
 * the project tier the outermost parent goes first for the same reason.
 *
 * The budget is spent in that same order and the walk STOPS when it runs out,
 * rather than reserving room for the nearest directories. Two reasons: it keeps
 * the single rule this module has always had (one shared budget, consumed in
 * render order, truncate the entry that straddles the end), and a scheme that
 * loaded `cwd` first would have to render in a different order than it read,
 * which is exactly the kind of split the truncation bug in context-prompt-13
 * came out of. The residual risk is real and bounded: a huge file in a distant
 * parent can crowd out a nearer one, the same way an oversized global already
 * could.
 */
export async function loadInstructionChain(
  source: InstructionSource,
  options: InstructionChainOptions
): Promise<readonly ProjectInstruction[]> {
  let remaining = Math.max(0, options.maxBytes ?? MAX_INSTRUCTION_BYTES);
  const entries: ProjectInstruction[] = [];
  const sources = resolveSettingSources(options);
  // T059 — real paths of every file already in the prompt. The user tier and
  // the walk both consult it, so a file a caller ALSO listed in `globals`
  // appears once rather than once per route that reaches it.
  const loaded = new Set<string>();

  for (const global of options.globals ?? []) {
    if (remaining <= 0) break;
    // decision 008 — a managed file is the product's own, not a "source" the
    // caller gets to switch off; anything else in this list came from the host
    // and is the `user` tier.
    if ((global.scope ?? 'user') === 'user' && !sources.user) continue;
    const content = (await source.readText(global.path))?.trim();
    if (!content) continue;
    const limited = limitUtf8(content, remaining);
    if (!limited) continue;
    entries.push({ source: global.label, content: limited });
    remaining -= Buffer.byteLength(limited, 'utf8');
    // The resolved spelling stands in when there is no real path: the walk
    // cannot read a file whose real path does not resolve either, so the key
    // only has to be stable, never canonical.
    loaded.add((await source.realpath(global.path)) ?? resolve(global.path));
  }

  // T059 — the user tier: one file from the home directory, for every
  // workspace, whether or not the workspace sits under it. Behind the `user`
  // switch alone: it is the user's own file, not something the checkout
  // supplied, so project trust does not enter into it — the rule `skillRoots`
  // already applies to `~/.agents/skills`. No `CLAUDE.local.md`: "local" means
  // private to one project, and the home directory is private already.
  const home = options.home ? resolve(options.home) : undefined;
  if (home && sources.user && !options.skipUserTier && remaining > 0) {
    const found = await readDirectoryInstructions(source, {
      labelRoot: home,
      directory: home,
      remaining,
      local: false,
      names: HOME_INSTRUCTION_FILE_NAMES,
      loaded,
    });
    for (const entry of found) {
      // `~/` so the heading says whose file this is; a bare `CLAUDE.md` would
      // read as the workspace's own.
      entries.push({ source: `~/${entry.source}`, content: entry.content });
      remaining -= Buffer.byteLength(entry.content, 'utf8');
    }
  }

  // decision 007 / 008 — an untrusted checkout contributes no instructions at
  // all. A CLAUDE.md is text the model is told to obey, so a folder the user
  // has not vouched for must not be able to write it, exactly as it must not be
  // able to contribute a skill or a permission rule.
  if (!options.root || remaining <= 0 || !sources.project) return entries;
  const resolvedRoot = resolve(options.root);
  const directories = instructionDirectories(resolvedRoot);
  // T059 — with the home directory on the walk, start strictly below it: the
  // directory itself was the user tier above, and the ones above it (`/home`,
  // `C:\Users`) belong to every account on the machine. Off the walk,
  // `findIndex` is -1 and `slice(0)` is the whole walk.
  const first = home ? directories.findIndex((directory) => sameDirectory(directory, home)) + 1 : 0;
  for (const directory of directories.slice(first)) {
    if (remaining <= 0) break;
    const found = await readDirectoryInstructions(source, {
      labelRoot: resolvedRoot,
      directory,
      remaining,
      local: sources.local,
      loaded,
    });
    for (const entry of found) {
      entries.push(entry);
      remaining -= Buffer.byteLength(entry.content, 'utf8');
    }
  }
  return entries;
}

/**
 * The rendered chain as plain text, for a consumer that is not building the
 * parent's prompt.
 *
 * P5-2-2's delegates need the workspace's own rules, but not the slot machinery
 * around them: a delegate's prompt is assembled by
 * `plugins/subagent/prompt.ts`, not by `composeSystemPrompt`. Sharing the
 * loader and the rendering — rather than re-deriving the chain there — is what
 * keeps a delegate reading the same instructions the parent does.
 */
export async function projectInstructionsText(
  source: InstructionSource,
  options: InstructionChainOptions
): Promise<string | undefined> {
  const entries = await loadInstructionChain(source, options);
  return projectInstructionsSegment(entries)?.text;
}

export function projectInstructionsSegment(
  entries: readonly ProjectInstruction[]
): PromptSegment | undefined {
  if (entries.length === 0) return undefined;
  const text = [
    '# Project instructions',
    '',
    'The following instructions are loaded from the workspace. Follow them when they apply to the task; where two entries conflict, the more specific file says so itself.',
    '',
    ...entries.flatMap((entry) => [`## ${entry.source}`, '', entry.content, '']),
  ]
    .join('\n')
    .trimEnd();
  return { slot: 'project-instructions', text };
}

/**
 * decision 007 — the on-demand tier's rendering.
 *
 * A separate function from {@link projectInstructionsSegment} because these
 * entries arrive mid-session as a message, not as a prompt slot, and the model
 * needs one extra sentence: WHY a new instruction file just showed up. The
 * accumulation rule is worded identically on purpose — a subdirectory's file is
 * not a new regime, it is one more entry in the same list.
 */
export function onDemandInstructionsText(
  entries: readonly ProjectInstruction[]
): string | undefined {
  if (entries.length === 0) return undefined;
  return [
    '# Project instructions (newly in scope)',
    '',
    'You just worked with files in a directory that carries its own instruction file. These add to the project instructions already in your system prompt; where two entries conflict, the more specific file says so itself.',
    '',
    ...entries.flatMap((entry) => [`## ${entry.source}`, '', entry.content, '']),
  ]
    .join('\n')
    .trimEnd();
}
