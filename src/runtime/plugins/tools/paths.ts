import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';

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
  io: RuntimeHostIoService,
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

async function existingAncestor(io: RuntimeHostIoService, absolute: string): Promise<string> {
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
  io: RuntimeHostIoService,
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
async function walkSegments(io: RuntimeHostIoService, absolute: string): Promise<string> {
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
