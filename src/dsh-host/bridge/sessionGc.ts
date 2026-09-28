/**
 * Decision 024 — the one deletion the shared DSH host performs (dsh-rebase
 * P1-3d): `aiclient-*` sessions nobody can reach and nothing was said in.
 *
 * DSH has no deletion API ("Nothing deletes session files",
 * dsh-session-persistence-jsonl), so this module removes a session directory
 * itself, and only when all of these hold:
 *
 *   ours      the id starts `aiclient-` (`dshSessionIdFor`): never a subagent
 *             child, never a session another client wrote
 *   orphaned  not claimed by Main's index, nor named by the stub of a claimed
 *             session — its `dshSessionId` and its whole `lineage`, the
 *             sessions rewinds retired (P1-4b, decision 027) — nor a
 *             descendant of a claimed session through its header's
 *             `parentSession`
 *   old       its header was created more than `graceMs` ago (24 h)
 *   empty     its log holds nothing but the setup events DSH writes when it
 *             creates an agent (measured in P1-3d: a session bootstrapped and
 *             never sent to holds exactly `permission/preset`, `sandbox/mode`
 *             and `approval/policy`, about 300 bytes); any other event keeps it
 *   unowned   the write lock is ours: `open(id, 'write')`, and emptiness is
 *             checked again under it
 *   in place  the directory is `<DSH_HOME>/sessions/<project>/<session>`, a real
 *             directory holding session logs and the lock file only
 *
 * The directory goes while the lock is held, the lock file with it: a lock file
 * is never removed on its own (removing it forfeits exclusion on POSIX). The
 * identity stub naming the session goes after it. A stub whose session
 * directory is gone, claimed by nobody and older than `graceMs`, goes too.
 *
 * P1-6c (decision 043): a stub's grant sidecar (`<id>.dsh.grants.json`) goes
 * with the stub, just before it, so a crash in between leaves a stub a later
 * pass collects rather than grants nothing names. Grants whose stub is gone
 * already (a staged fork Main's startup sweep took, say) go by the stub's own
 * rules: ours, claimed by nobody, no session of that id listed, and last
 * written more than `graceMs` ago.
 *
 * Emptiness is read before the lock is taken: a write open of an older log
 * format publishes a migrated copy, which a session that turns out to hold
 * content must not get from a clean-up pass.
 */

import { lstat, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DshHostGcResult, DshHostGcSkipReason } from '../../shared/types/dshHostProtocol.ts';
import { DSH_SESSION_ID_PREFIX, hasNamedError } from './dshSessionRuntime.ts';
import { DSH_GRANTS_SUFFIX, DSH_STUB_DIR, DSH_STUB_SUFFIX } from './stub.ts';

/** Events DSH appends when it creates an agent, before anything is said (measured, P1-3d). */
export const DSH_SESSION_SETUP_EVENTS: ReadonlySet<string> = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
]);

/** A setup-only log measured about 300 bytes; one past this is not read, it is kept. */
export const EMPTY_SESSION_MAX_BYTES = 16 * 1024;

/** Events read to judge emptiness; more than this is content whatever they are. */
const SETUP_EVENT_LIMIT = 16;

/** What a session directory may hold: log generations and the kernel lock file. */
const SESSION_LOG_NAME = /^session(\.v[0-9]+)?\.jsonl(\.zstd)?$/;
const SESSION_LOCK_NAME = 'session.lock';

/** The header fields read here (dsh-session `SessionHeader`). */
export interface GcSessionHeader {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
}

/** `sessionPersistence.list()` entry: `sizeBytes` is absent while unmaterialized. */
export interface GcSessionSnapshot {
  readonly header: GcSessionHeader;
  readonly sizeBytes?: number;
}

export interface GcSessionHandle {
  read(offset?: number, length?: number): Promise<{ readonly events: readonly { type: string }[] }>;
  close(): Promise<void>;
}

/** The slice of `ctx.sessionPersistence` (dsh-session-persistence-jsonl) used here. */
export interface GcPersistence {
  list(): Promise<readonly GcSessionSnapshot[]>;
  open(id: string, access: 'read' | 'write'): Promise<GcSessionHandle>;
  /** The JSONL backend's diagnostics hook: the current log path a header names. */
  locate?(header: GcSessionHeader): { kind: string; path: string };
}

export interface GcFileSystem {
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options: { recursive: true }): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: GcFileSystem = { lstat, readdir, rm, readFile, stat, unlink };

export interface SessionGcOptions {
  persistence: GcPersistence;
  /** `$DSH_HOME`: the stub directory and the session root are under it. */
  home: string;
  /** Epoch milliseconds, as header and stub `createdAt` are. */
  now?: () => number;
  fs?: GcFileSystem;
  platform?: NodeJS.Platform;
  log?: (...args: unknown[]) => void;
}

export interface SessionGcRequest {
  claimed: readonly string[];
  graceMs: number;
}

export type SessionGcOutcome = Omit<DshHostGcResult, 'host' | 'id'>;

type Verdict = 'deleted' | DshHostGcSkipReason;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** The sessions a stub names: its current one and every one of its lineage. */
function stubSessionIds(stub: unknown): string[] {
  const record = stub as { dshSessionId?: unknown; lineage?: unknown } | undefined;
  const ids: unknown[] = [record?.dshSessionId];
  if (Array.isArray(record?.lineage)) {
    for (const entry of record.lineage)
      ids.push((entry as { dshSessionId?: unknown })?.dshSessionId);
  }
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Claimed ids, plus what the stubs of claimed sessions name (Main reads the
 * same stubs; this holds when it could not), plus every session descending
 * from one through `parentSession`.
 */
function expandClaimed(
  snapshots: readonly GcSessionSnapshot[],
  claimedIds: readonly string[],
  stubs: ReadonlyArray<{ id: string; names: readonly string[] }>
): Set<string> {
  const claimed = new Set(claimedIds);
  for (const stub of stubs) {
    if (claimed.has(stub.id) || stub.names.some((id) => claimed.has(id))) {
      for (const id of stub.names) claimed.add(id);
    }
  }
  const children = new Map<string, string[]>();
  for (const { header } of snapshots) {
    if (typeof header.parentSession !== 'string') continue;
    const siblings = children.get(header.parentSession) ?? [];
    siblings.push(header.id);
    children.set(header.parentSession, siblings);
  }
  const queue = [...claimed];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const child of children.get(id) ?? []) {
      if (claimed.has(child)) continue;
      claimed.add(child);
      queue.push(child);
    }
  }
  return claimed;
}

async function holdsOnlySetup(handle: GcSessionHandle): Promise<boolean> {
  const { events } = await handle.read(0, SETUP_EVENT_LIMIT + 1);
  return (
    events.length <= SETUP_EVENT_LIMIT &&
    events.every((event) => DSH_SESSION_SETUP_EVENTS.has(event.type))
  );
}

async function closeQuietly(handle: GcSessionHandle, log: (...args: unknown[]) => void) {
  try {
    await handle.close();
  } catch (error) {
    log(`gc: closing a session handle failed: ${errorText(error)}`);
  }
}

export async function collectOrphanSessions(
  options: SessionGcOptions,
  request: SessionGcRequest
): Promise<SessionGcOutcome> {
  const started = performance.now();
  const { persistence } = options;
  const fs = options.fs ?? nodeFileSystem;
  const log = options.log ?? (() => {});
  const win32 = (options.platform ?? process.platform) === 'win32';
  const samePath = (left: string, right: string) =>
    win32 ? left.toLowerCase() === right.toLowerCase() : left === right;
  const home = resolve(options.home);
  const sessionsRoot = join(home, 'sessions');
  const stubDir = join(home, DSH_STUB_DIR);
  const cutoff = (options.now ?? Date.now)() - request.graceMs;
  const skipped: Partial<Record<DshHostGcSkipReason, number>> = {};
  const deleted: string[] = [];
  let stubsDeleted = 0;

  // A list that fails ends the pass: nothing is judged orphaned without it.
  const snapshots = await persistence.list();
  const present = new Set(snapshots.map((snapshot) => snapshot.header.id));

  let stubNames: string[] = [];
  try {
    stubNames = await fs.readdir(stubDir);
  } catch (error) {
    if (!isMissing(error)) log(`gc: cannot read ${stubDir}: ${errorText(error)}`);
  }
  const stubs: Array<{ id: string; names: string[] }> = [];
  for (const name of stubNames) {
    if (!name.endsWith(DSH_STUB_SUFFIX)) continue;
    try {
      const names = stubSessionIds(JSON.parse(await fs.readFile(join(stubDir, name), 'utf8')));
      stubs.push({ id: name.slice(0, -DSH_STUB_SUFFIX.length), names });
    } catch {
      // An unreadable stub claims nothing beyond its own name, which Main claims.
    }
  }
  const claimed = expandClaimed(snapshots, request.claimed, stubs);

  /** `<root>/<project>/<session>`, a real directory holding logs and the lock only. */
  const verifiedSessionDir = async (
    header: GcSessionHeader
  ): Promise<{ dir: string; logs: string[] } | null> => {
    let located: { kind: string; path: string } | undefined;
    try {
      located = persistence.locate?.(header);
    } catch {
      return null;
    }
    if (located?.kind !== 'jsonl' || typeof located.path !== 'string') return null;
    const dir = resolve(dirname(located.path));
    if (!samePath(dirname(dirname(dir)), sessionsRoot)) return null;
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const names = await fs.readdir(dir);
    const logs = names.filter((name) => SESSION_LOG_NAME.test(name));
    if (
      logs.length === 0 ||
      logs.length + (names.includes(SESSION_LOCK_NAME) ? 1 : 0) !== names.length
    ) {
      return null;
    }
    return { dir, logs: logs.map((name) => join(dir, name)) };
  };

  /** `file` gone; one that is gone already is not a failure. */
  const unlinkIfPresent = async (file: string): Promise<void> => {
    try {
      await fs.stat(file);
      await fs.unlink(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  /** The grants of the stub named after `id` (decision 043), which go just before it. */
  const removeGrantsOf = (id: string) =>
    unlinkIfPresent(join(stubDir, `${id}${DSH_GRANTS_SUFFIX}`));

  /** The stub named after `id`, when it names `id`; a stub naming another session stays. */
  const removeStubOf = async (id: string): Promise<boolean> => {
    const file = join(stubDir, `${id}${DSH_STUB_SUFFIX}`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    let stub: unknown;
    try {
      stub = JSON.parse(text);
    } catch {
      stub = undefined;
    }
    if ((stub as { dshSessionId?: unknown } | undefined)?.dshSessionId !== id) {
      log(`gc: kept ${basename(file)}: it does not name ${id}`);
      return false;
    }
    await removeGrantsOf(id);
    await fs.unlink(file);
    return true;
  };

  const collectSession = async (snapshot: GcSessionSnapshot): Promise<Verdict> => {
    const { header } = snapshot;
    const id = header.id;
    if (!id.startsWith(DSH_SESSION_ID_PREFIX)) return 'foreign';
    if (claimed.has(id)) return 'claimed';
    if (!Number.isFinite(header.createdAt) || header.createdAt > cutoff) return 'recent';
    if (snapshot.sizeBytes === undefined) return 'unmaterialized';
    if (snapshot.sizeBytes > EMPTY_SESSION_MAX_BYTES) return 'content';
    const reader = await persistence.open(id, 'read');
    try {
      if (!(await holdsOnlySetup(reader))) return 'content';
    } finally {
      await closeQuietly(reader, log);
    }
    let writer: GcSessionHandle;
    try {
      writer = await persistence.open(id, 'write');
    } catch (error) {
      if (hasNamedError(error, 'SessionAlreadyOwnedError')) return 'locked';
      throw error;
    }
    try {
      if (!(await holdsOnlySetup(writer))) return 'content';
      const target = await verifiedSessionDir(header);
      if (target === null) return 'unexpected';
      // While the lock is still ours: the logs first, then the directory with
      // the lock file in it. A failure part-way leaves a log with its lock, or
      // a lone lock no log needs; never a log without its lock.
      for (const file of target.logs) await fs.unlink(file);
      await fs.rm(target.dir, { recursive: true });
    } finally {
      await closeQuietly(writer, log);
    }
    if (await removeStubOf(id)) stubsDeleted += 1;
    return 'deleted';
  };

  /** A stub whose session is not listed: kept while anything could still need it. */
  const collectStub = async (name: string, id: string): Promise<Verdict | null> => {
    if (!id.startsWith(DSH_SESSION_ID_PREFIX)) return 'foreign';
    if (claimed.has(id)) return 'claimed';
    const file = join(stubDir, name);
    let stub: { dshSessionId?: unknown; cwd?: unknown; createdAt?: unknown } | undefined;
    try {
      stub = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (isMissing(error)) return null;
      stub = undefined;
    }
    if (typeof stub?.dshSessionId !== 'string' || typeof stub.cwd !== 'string' || !stub.cwd) {
      return 'unexpected';
    }
    // Names a live session under another name (lineage): not an orphan.
    if (present.has(stub.dshSessionId)) return null;
    if (claimed.has(stub.dshSessionId)) return 'claimed';
    const createdAt =
      typeof stub.createdAt === 'number' ? stub.createdAt : (await fs.stat(file)).mtimeMs;
    if (!Number.isFinite(createdAt) || createdAt > cutoff) return 'recent';
    // A log DSH cannot list (an unreadable header) still keeps its identity.
    let located: { kind: string; path: string } | undefined;
    try {
      located = persistence.locate?.({ id: stub.dshSessionId, cwd: stub.cwd, createdAt: 0 });
    } catch {
      return 'unexpected';
    }
    if (typeof located?.path !== 'string') return 'unexpected';
    try {
      await fs.lstat(dirname(located.path));
      return 'unexpected';
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await removeGrantsOf(id);
    await fs.unlink(file);
    return 'deleted';
  };

  /** Grants whose stub is gone: kept while anything could still need them, as a stub is. */
  const collectGrants = async (name: string, id: string): Promise<boolean> => {
    if (!id.startsWith(DSH_SESSION_ID_PREFIX) || claimed.has(id) || present.has(id)) return false;
    const file = join(stubDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!Number.isFinite(mtimeMs) || mtimeMs > cutoff) return false;
    await unlinkIfPresent(file);
    return true;
  };

  const count = (reason: DshHostGcSkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const snapshot of snapshots) {
    let verdict: Verdict;
    try {
      verdict = await collectSession(snapshot);
    } catch (error) {
      log(`gc: ${snapshot.header.id}: ${errorText(error)}`);
      verdict = 'failed';
    }
    if (verdict === 'deleted') deleted.push(snapshot.header.id);
    else count(verdict);
  }

  for (const name of stubNames) {
    // Temp files of an interrupted stub write are not stubs.
    if (!name.endsWith(DSH_STUB_SUFFIX)) continue;
    const id = name.slice(0, -DSH_STUB_SUFFIX.length);
    // A listed session's stub was judged with its session above.
    if (present.has(id)) continue;
    let verdict: Verdict | null;
    try {
      verdict = await collectStub(name, id);
    } catch (error) {
      log(`gc: stub ${name}: ${errorText(error)}`);
      verdict = 'failed';
    }
    if (verdict === 'deleted') stubsDeleted += 1;
    else if (verdict !== null) count(verdict);
  }

  for (const name of stubNames) {
    if (!name.endsWith(DSH_GRANTS_SUFFIX)) continue;
    const id = name.slice(0, -DSH_GRANTS_SUFFIX.length);
    // Grants beside a stub were judged with it: they went with it, or they stay.
    if (stubNames.includes(`${id}${DSH_STUB_SUFFIX}`)) continue;
    try {
      if (await collectGrants(name, id)) log(`gc: deleted ${name}: its stub is gone`);
    } catch (error) {
      log(`gc: grants ${name}: ${errorText(error)}`);
    }
  }

  return {
    ok: true,
    deleted,
    stubsDeleted,
    skipped,
    ms: Math.round(performance.now() - started),
  };
}
