/**
 * What "Allow for session" actually remembers.
 *
 * It used to remember the REQUEST: `[tool, path, command, paths]` stringified,
 * compared byte for byte. That is a grant that almost never matches again. A
 * user who allowed `edit src/a.ts` was asked again for `src/b.ts`; a user who
 * allowed `npm test` was asked again for `npm test -- --watch`, and again for
 * the same command with one extra flag. The feature read as broken because in
 * practice it granted nothing — the second call was always a different string.
 *
 * So a grant is now a SHAPE rather than a literal:
 *
 *  - a file tool remembers a DIRECTORY, and covers that directory and
 *    everything under it for the same tool;
 *  - `bash` remembers a COMMAND PREFIX plus the workspace it was approved in,
 *    and covers any later command whose every segment starts with a granted
 *    prefix.
 *
 * Both are deliberately narrow in the one direction that matters: a grant says
 * "this kind of call, in this place". It never says "this tool, anywhere", and
 * the checks it does NOT answer (a secret file, a path outside the workspace)
 * stay with the gate — see `PermissionsPlugin.granted`.
 */

import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
import type { PermissionGrantScope } from '../../../shared/types/runtimeEvents.ts';
import { PERMISSION_GRANTS_ENTRY } from '../session/legacy.ts';
import type { ToolPermissionRequest } from './index.ts';

export { PERMISSION_GRANTS_ENTRY };

/**
 * One remembered approval.
 *
 * `value` is the unchanged old behaviour, kept for the two surfaces whose
 * "path" is not a path at all: an MCP call sends the workspace root as `path`
 * and the real subject as `policyValue` (`server:tool`), and a skill sends the
 * skill file with the skill NAME as `policyValue`. Widening those to a
 * directory would grant every MCP tool on a server, or every skill in a folder,
 * from one approval — so they stay exact.
 */
export type PermissionGrant =
  | { kind: 'path'; tool: string; dir: string }
  | { kind: 'command'; prefix: string; root: string }
  | { kind: 'value'; tool: string; value: string };

/** Stable identity of a grant, for set membership and de-duplication. */
export function grantKeyOf(grant: PermissionGrant): string {
  if (grant.kind === 'command') return JSON.stringify(['command', grant.prefix, grant.root]);
  if (grant.kind === 'path') return JSON.stringify(['path', grant.tool, grant.dir]);
  return JSON.stringify(['value', grant.tool, grant.value]);
}

/**
 * Is `path` inside `root` (or `root` itself)?
 *
 * Lives here rather than beside the gate because the grant matcher is the
 * heaviest user of it and importing the gate from here would close a cycle.
 * `index.ts` re-exports it, so every existing importer is unaffected.
 */
export function containsPath(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

/**
 * Tools whose `path` IS the directory, not a file inside one.
 *
 * `glob` and `grep` are handed a search root (`tools/index.ts` passes
 * `args.path ?? '.'`), so taking its parent would silently grant one level
 * above what the user was shown. Everything else — read, write, edit,
 * browser_preview — names a file, and the directory the user meant is the file's
 * own.
 */
const DIRECTORY_ROOT_TOOLS: readonly string[] = ['glob', 'grep'];

/**
 * Programs whose first argument is a SUBCOMMAND, not an operand.
 *
 * The prefix is what a later command is matched against, so for these the verb
 * alone is far too much: approving `git status` must not approve `git push`,
 * and approving `npm test` must not approve `npm publish`. Two words is the
 * whole rule — nobody meant to distinguish `npm test --watch` from `npm test`.
 *
 * Interpreters (`python`, `node`) are in the list for the same reason read the
 * other way round: their first argument is the script, and the script is what
 * the user actually approved.
 */
const MULTI_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'git',
  'cargo',
  'dotnet',
  'go',
  'python',
  'python3',
  'node',
  'make',
  'cmake',
  'docker',
  'kubectl',
]);

/**
 * The prefix one command segment is remembered by, or `undefined` when it has
 * none that means anything.
 *
 * The undefined case is not an edge case to tidy away: the shell analysis emits
 * a segment with no readable program name (`$(which rm) -rf x` reduces to
 * `-rf x`) and a prefix taken from it would be the word `-rf` — a "grant" that
 * matches an arbitrary program's flags. A segment like that makes the whole
 * command un-grantable, which costs one extra card and cannot be wrong.
 */
export function commandPrefix(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const head = words[0];
  if (!head || head.startsWith('-')) return undefined;
  if (!MULTI_COMMAND_TOOLS.has(basename(head))) return head;
  const second = words[1];
  return second && !second.startsWith('-') ? `${head} ${second}` : head;
}

/**
 * Every prefix a bash request would have to have been granted.
 *
 * Reuses the shell analysis rather than re-lexing: `commands` already holds one
 * entry per `command` node the AST walk found, so a pipeline, an `&&` chain and
 * a `bash -c` body are already split — and the unwrapped spelling of a wrapped
 * command (`timeout 5 npm test` also yields `npm test`) is already in there too,
 * which is why requiring ALL of them is the safe reading: the inner verb is
 * checked even when the outer wrapper's prefix was granted.
 *
 * `undefined` means "this command cannot be remembered", and every caller
 * treats that as neither grantable nor granted.
 */
export function commandPrefixes(request: ToolPermissionRequest): string[] | undefined {
  const segments = request.commands?.length
    ? request.commands
    : request.command
      ? [request.command]
      : [];
  if (segments.length === 0) return undefined;
  const prefixes = new Set<string>();
  for (const segment of segments) {
    const prefix = commandPrefix(segment);
    if (prefix === undefined) return undefined;
    prefixes.add(prefix);
  }
  return prefixes.size > 0 ? [...prefixes] : undefined;
}

/** The directory a file-tool grant is anchored at. See `DIRECTORY_ROOT_TOOLS`. */
function grantDirectory(tool: string, path: string): string {
  return DIRECTORY_ROOT_TOOLS.includes(tool) ? path : dirname(path);
}

/**
 * What pressing "Allow for session" on this request writes down.
 *
 * Empty means nothing can be remembered — the approval then behaves exactly
 * like "Allow once", which is the honest outcome for a command whose own
 * program name could not be read.
 */
export function grantsFor(request: ToolPermissionRequest): PermissionGrant[] {
  if (request.tool === 'bash') {
    const prefixes = commandPrefixes(request);
    if (!prefixes) return [];
    return prefixes.map((prefix) => ({ kind: 'command', prefix, root: request.path }));
  }
  if (request.policyValue !== undefined)
    return [{ kind: 'value', tool: request.tool, value: request.policyValue }];
  const inspected = [request.path, ...(request.paths ?? [])];
  const seen = new Set<string>();
  const grants: PermissionGrant[] = [];
  for (const path of inspected) {
    const grant: PermissionGrant = {
      kind: 'path',
      tool: request.tool,
      dir: grantDirectory(request.tool, path),
    };
    const key = grantKeyOf(grant);
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(grant);
  }
  return grants;
}

/**
 * Do the grants already given cover this request?
 *
 * Every path / every segment, not any: a call that touches one granted
 * directory and one that was never mentioned is a call the user has not
 * approved, and the same goes for `npm test && rm -rf build` when only the
 * first half was ever allowed.
 */
export function grantCovers(
  grants: Iterable<PermissionGrant>,
  request: ToolPermissionRequest
): boolean {
  const held = [...grants];
  if (held.length === 0) return false;
  if (request.tool === 'bash') {
    const prefixes = commandPrefixes(request);
    if (!prefixes) return false;
    return prefixes.every((prefix) =>
      held.some(
        (grant) =>
          grant.kind === 'command' &&
          grant.prefix === prefix &&
          containsPath(grant.root, request.path)
      )
    );
  }
  if (request.policyValue !== undefined) {
    const value = request.policyValue;
    return held.some(
      (grant) => grant.kind === 'value' && grant.tool === request.tool && grant.value === value
    );
  }
  return [request.path, ...(request.paths ?? [])].every((path) =>
    held.some(
      (grant) =>
        grant.kind === 'path' && grant.tool === request.tool && containsPath(grant.dir, path)
    )
  );
}

/**
 * How the approval card describes what it is about to remember.
 *
 * The card offered a button called "Allow for session" and said nothing about
 * its reach, which was survivable while the grant was one exact call and is not
 * now that it is a directory or a command family. `undefined` for the exact
 * kinds (MCP, skills), whose reach is unchanged and already obvious from the
 * request itself.
 */
export function describeGrantScope(
  request: ToolPermissionRequest,
  cwd: string
): PermissionGrantScope | undefined {
  if (request.tool === 'bash') {
    const prefixes = commandPrefixes(request);
    return prefixes ? { kind: 'command', value: prefixes.join(', ') } : undefined;
  }
  if (request.policyValue !== undefined) return undefined;
  const directories = new Set(
    [request.path, ...(request.paths ?? [])].map((path) => grantDirectory(request.tool, path))
  );
  if (directories.size === 0) return undefined;
  return {
    kind: 'directory',
    value: [...directories].map((dir) => displayPath(dir, cwd)).join(', '),
  };
}

/**
 * A directory as the user should read it: workspace-relative with a trailing
 * separator, absolute when it is not in the workspace at all. An approval that
 * reaches outside the project has to LOOK like one, so `../../etc` is never
 * shown in place of the path it means.
 */
function displayPath(dir: string, cwd: string): string {
  if (!containsPath(cwd, dir)) return dir;
  const delta = relative(cwd, dir);
  return delta === '' ? './' : `${delta}/`;
}

/**
 * The storage format version.
 *
 * Bumping it is how a future change to the grant shape retires the old records
 * instead of half-reading them: an unrecognised version is dropped and the
 * session simply starts with no grants, which costs a few extra cards and can
 * never mis-apply an approval whose meaning has changed.
 */
export const PERMISSION_GRANTS_VERSION = 1;

export interface PersistedGrants {
  version: number;
  grants: PermissionGrant[];
}

export function encodeGrants(grants: Iterable<PermissionGrant>): PersistedGrants {
  return { version: PERMISSION_GRANTS_VERSION, grants: [...grants] };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseGrant(value: unknown): PermissionGrant | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind === 'path') {
    const tool = text(row.tool);
    const dir = text(row.dir);
    return tool && dir ? { kind: 'path', tool, dir } : undefined;
  }
  if (row.kind === 'command') {
    const prefix = text(row.prefix);
    const root = text(row.root);
    return prefix && root ? { kind: 'command', prefix, root } : undefined;
  }
  if (row.kind === 'value') {
    const tool = text(row.tool);
    const grantValue = text(row.value);
    return tool && grantValue ? { kind: 'value', tool, value: grantValue } : undefined;
  }
  return undefined;
}

/**
 * Read one persisted record back.
 *
 * `undefined` means "this record says nothing" — a shape from a version this
 * build does not know. It is deliberately NOT an error: a session file written
 * by a newer build must still open, and the worst a dropped grant can do is ask
 * a question that was already answered once.
 */
export function decodeGrants(data: unknown): PermissionGrant[] | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  if (row.version !== PERMISSION_GRANTS_VERSION) return undefined;
  if (!Array.isArray(row.grants)) return undefined;
  const grants: PermissionGrant[] = [];
  for (const item of row.grants) {
    const grant = parseGrant(item);
    if (grant) grants.push(grant);
  }
  return grants;
}

/**
 * The grants a resumed session starts with.
 *
 * Last record wins, including when the last record is the empty one `configure`
 * writes: forgetting the grants in memory and leaving them on disk would bring
 * them all back on the next open, which is the opposite of what changing the
 * permission posture means. An unreadable record resets to empty for the same
 * reason — it is evidence that what is stored is not what this build reads.
 */
export function restoredGrants(entries: readonly { type: string }[]): PermissionGrant[] {
  let grants: PermissionGrant[] = [];
  for (const entry of entries) {
    const row = entry as { type: string; customType?: string; data?: unknown };
    if (row.type !== 'custom' || row.customType !== PERMISSION_GRANTS_ENTRY) continue;
    grants = decodeGrants(row.data) ?? [];
  }
  return grants;
}
