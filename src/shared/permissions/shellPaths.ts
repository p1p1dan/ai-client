// Moved from src/runtime/plugins/tools/index.ts (target, checkShellPaths) and src/runtime/plugins/tools/paths.ts (canonicalPath) (dsh-rebase P1-6a)

import { basename, dirname, isAbsolute, join, matchesGlob, parse, resolve, sep } from 'node:path';
import { type BashAnalysis, splitShellPath } from './bashWalker.ts';
import { createPermissionError, errorCode, type PermissionErrorFactory } from './errors.ts';
import type { ToolPermissionRequest } from './gate.ts';
import { pathPolicy } from './pathPolicy.ts';

/**
 * The filesystem calls the path checks make; each host supplies its own. The
 * runtime's `RuntimeHostIoService` fits as is.
 */
export interface PermissionFileSystem {
  /** Rejects with `code: 'ENOENT'` when nothing is there to resolve. */
  realpath(path: string): Promise<string>;
  readDirectory(path: string): AsyncIterable<{ name: string }>;
}

/** Where a tool's operands are judged, and how a failure is reported. */
export interface ShellPathContext {
  fs: PermissionFileSystem;
  cwd: string;
  createError?: PermissionErrorFactory;
}

/**
 * Filesystem races a traversal or a shell-path expansion must not fail on: a
 * dangling/looping symlink, a directory that vanished or was never there, or
 * one the process cannot read. The same set the runtime's tools plugin uses
 * for "treat this entry as absent".
 */
const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);
function isSkippableIoError(error: unknown): boolean {
  return OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '');
}

/** A `..` that is a whole segment, not part of a name like `..rc`. */
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** Windows accepts both separators; on POSIX a backslash is a legal name character. */
const SEGMENT_SEPARATOR = sep === '\\' ? /[\\/]/ : /\//;

/**
 * `\\?\UNC\srv\share` and `\\.\UNC\srv\share` are ONE root each, but win32
 * `parse` stops them at `\\?\UNC\`. Walking `srv` and `share` as if they were
 * ordinary directories would fail to resolve a bare server name and drop the
 * whole tail into the unresolved branch below.
 */
const EXTENDED_UNC_ROOT = /^\\\\[?.]\\UNC\\$/i;

// Canonicalize the existing ancestor so new targets cannot escape through a symlink.
export async function canonicalPath(
  io: Pick<PermissionFileSystem, 'realpath'>,
  cwd: string,
  input: string
): Promise<string> {
  const absolute = isAbsolute(input) ? input : `${cwd}${sep}${input}`;
  // win32 realpath folds `..` as text BEFORE it looks at the filesystem, so
  // `<ws>/link/../secret` is read as `<ws>/secret` while the shell — which
  // resolves the link first — opens the file beside the link's TARGET. The
  // guard and the executor would then be judging two different files, so a
  // path carrying a `..` segment is resolved one segment at a time instead.
  if (PARENT_SEGMENT.test(absolute)) return walkSegments(io, absolute);
  return existingAncestor(io, absolute);
}

async function existingAncestor(
  io: Pick<PermissionFileSystem, 'realpath'>,
  absolute: string
): Promise<string> {
  try {
    return await io.realpath(absolute);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await existingAncestor(io, parent), basename(absolute));
  }
}

/** `realpath`, or the candidate itself when nothing is there to resolve yet. */
async function resolveOrMissing(
  io: Pick<PermissionFileSystem, 'realpath'>,
  candidate: string
): Promise<{ path: string; missing: boolean }> {
  try {
    return { path: await io.realpath(candidate), missing: false };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    // Same fallback as the fast path: a target that does not exist yet (or a
    // dangling link) keeps a canonical prefix and a lexical tail.
    return { path: candidate, missing: true };
  }
}

/**
 * POSIX realpath semantics: resolve the prefix, THEN apply `..` to whatever it
 * resolved to. Only reached for paths that carry a `..` segment, so the common
 * case keeps its single realpath call.
 *
 * Invariant this must hold: **the returned path contains no unresolved link
 * segment above the first component that does not exist**. Callers do not just
 * judge this string, they OPEN it (`tools/index.ts` hands it to `io.stat` and
 * to the read/write bodies), so a junction left unresolved in it is a junction
 * the OS traverses after the guard has already approved the wrong target.
 */
async function walkSegments(
  io: Pick<PermissionFileSystem, 'realpath'>,
  absolute: string
): Promise<string> {
  const { root, segments } = splitRoot(absolute);
  let current = root;
  /**
   * How many segments deep we are inside a component that does not resolve.
   * A counter rather than a flag, because `..` can cancel that component and
   * put us back on a directory that DOES exist — after which every further
   * segment has to be resolved again. A flag that never cleared would return
   * `<ws>/nosuchdir/../link/x` as `<ws>/link/x`: inside the workspace on paper,
   * a junction to anywhere on disk when opened.
   */
  let missing = 0;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      current = dirname(current);
      if (missing === 0) continue;
      if (--missing > 0) continue;
      // Back out of the unresolved region: `current` names a real directory
      // again, so it is resolved once more and the tail stops being lexical.
      // If it cannot be resolved, the count stays up — fail closed.
      const climbed = await resolveOrMissing(io, current);
      current = climbed.path;
      missing = climbed.missing ? 1 : 0;
      continue;
    }
    const next = join(current, segment);
    if (missing > 0) {
      missing++;
      current = next;
      continue;
    }
    const resolved = await resolveOrMissing(io, next);
    current = resolved.path;
    missing = resolved.missing ? 1 : 0;
  }
  return current;
}

/**
 * The root the walk starts from, and the segments below it.
 *
 * `dirname` is its own fixed point on `C:\`, `\\srv\share`, `\\?\C:\` and `/`,
 * so a `..` that climbs past one of those stays there, like POSIX `/..`. The
 * extended UNC spelling is the exception that has to be repaired here rather
 * than relied on: its parse root stops short of the share.
 */
function splitRoot(absolute: string): { root: string; segments: string[] } {
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(SEGMENT_SEPARATOR);
  if (!EXTENDED_UNC_ROOT.test(root)) return { root, segments };
  const share = segments.splice(0, 2).join('\\');
  return { root: `${root}${share}`, segments };
}

/**
 * Resolve, approve and re-check one tool target; the canonical path it
 * returns is the one the tool must open.
 *
 * Three steps, in this order: a literal deny on the spelling the model wrote,
 * canonical resolution, then the gate. The target is resolved once more after
 * the approval, because the wait for a person can be long and a symlink swapped
 * during it would otherwise be opened under an approval given for another file.
 */
export async function authorizeTarget(
  context: {
    fs: Pick<PermissionFileSystem, 'realpath'>;
    cwd: string;
    createError?: PermissionErrorFactory;
    authorize: (request: ToolPermissionRequest, signal?: AbortSignal) => Promise<void>;
  },
  target: {
    tool: string;
    toolCallId: string;
    input: string;
    signal?: AbortSignal;
    command?: string;
    shell?: BashAnalysis;
    /** Content the approval card shows verbatim; see `ToolPermissionRequest`. */
    preview?: { label: string; text: string };
  }
): Promise<string> {
  const createError = context.createError ?? createPermissionError;
  const { tool, toolCallId, input, signal, command, shell, preview } = target;
  const lexical = resolve(context.cwd, input);
  if (pathPolicy(lexical) === 'deny') throw createError('tool_denied', `access denied: ${lexical}`);
  const path = await canonicalPath(context.fs, context.cwd, input);
  await context.authorize(
    {
      tool,
      toolCallId,
      path,
      command,
      paths: shell?.paths,
      commands: shell?.commands,
      unresolvedPaths: shell?.unresolvedPaths,
      exploration: shell?.exploration,
      ...(shell?.ungrantable ? { ungrantable: true } : {}),
      ...(preview ? { preview } : {}),
    },
    signal
  );
  signal?.throwIfAborted();
  const current = await canonicalPath(context.fs, context.cwd, input);
  if (current !== path)
    throw createError(
      'path_changed',
      'path changed during approval; retry to authorize the new target'
    );
  return path;
}

/**
 * Expand every operand a shell analysis found and check each against the path
 * deny list, both as written and after canonical resolution; wildcards are
 * expanded against the directory (at most 20 000 entries in all). Returns the
 * analysis with `paths` replaced by every spelling that was checked.
 */
export async function checkShellPaths(
  analysis: BashAnalysis,
  context: ShellPathContext
): Promise<BashAnalysis> {
  const createError = context.createError ?? createPermissionError;
  const paths = new Set<string>();
  let visits = 0;
  const check = async (lexical: string) => {
    if (++visits > 20_000)
      throw createError('shell_path_limit', 'shell path expansion exceeds 20000 entries');
    if (pathPolicy(lexical) === 'deny')
      throw createError('tool_denied', `shell operand is denied: ${lexical}`);
    const canonical = await canonicalPath(context.fs, context.cwd, lexical);
    if (pathPolicy(canonical) === 'deny')
      throw createError('tool_denied', `shell operand is denied: ${canonical}`);
    paths.add(lexical);
    paths.add(canonical);
  };
  const expand = async (path: string): Promise<void> => {
    // Split on either separator: a command writes `conf/*` even on Windows,
    // where splitting on `sep` alone leaves the wildcard glued to its parent
    // and every entry fails to match, so nothing gets checked.
    const parts = splitShellPath(path);
    const wildcard = parts.findIndex((part) => /[*?[]/.test(part));
    if (wildcard < 0) return check(path);
    const parent = parts.slice(0, wildcard).join(sep) || sep;
    await check(parent);
    // Even an unmatched pattern can target denied names after another command creates them.
    if (pathPolicy(path) === 'deny')
      throw createError('tool_denied', `shell pattern is denied: ${path}`);
    try {
      for await (const entry of context.fs.readDirectory(parent)) {
        if (++visits > 20_000)
          throw createError('shell_path_limit', 'shell path expansion exceeds 20000 entries');
        if (entry.name.startsWith('.') && !parts[wildcard].startsWith('.')) continue;
        if (!matchesGlob(entry.name, parts[wildcard])) continue;
        await expand([parent, entry.name, ...parts.slice(wildcard + 1)].join(sep));
      }
    } catch (error) {
      // Parent doesn't exist / isn't a directory / isn't readable: a real
      // shell would just fail to expand the wildcard, not abort the command.
      if (!isSkippableIoError(error)) throw error;
    }
  };
  for (const path of analysis.paths) await expand(path);
  return { ...analysis, paths: [...paths].sort() };
}
