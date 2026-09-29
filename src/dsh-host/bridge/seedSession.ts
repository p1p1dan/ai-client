/**
 * Decision 054 (dsh-rebase P1-9c): one legacy pi session file made a DSH
 * session, run by the host for Main (`{host:'seedSession'}`, protocol in
 * src/shared/types/dshHostProtocol.ts), with no channel and no model turn.
 *
 *   read     the file Main names, read-only: one `open(…, 'r')`, the size
 *            cap before the read, a stat before and after (a file changing
 *            under the read is `source_busy`), and Main's own stat when it
 *            sent one (`expect`). A legacy file (pi v1–v3, PI-Desktop) with a
 *            1.0.x `.native-v4.jsonl` copy beside it is read through the copy,
 *            as 1.0.x opened it (`prepareSessionConfig`); a copy made from
 *            other bytes is `session_import_source_changed`, as there.
 *   convert  the P1-9b converter, pure: the active branch as a seed.
 *   reuse    a stub for this chat recording this very conversion (source
 *            hashes, converter version, cwd) whose session reads back is the
 *            answer; nothing is written.
 *   admit    each image through the send path's `admitUserContent`
 *            (decision 112), one at a time; one the store refuses becomes the
 *            converter's placeholder text.
 *   create   `agents.create({seed})` — a replayed history, not a fork — then
 *            `sessions.flush` and dispose, under `aiclient-<logical id>`; a
 *            log already there under that id holding exactly this seed is
 *            taken as it is, any other one is stepped past to `_m<n>`.
 *   verify   a cold `observeSession`: DSH reads the log back and it is the
 *            seed and its `session/end-seed`. The seed constructor takes what
 *            the reader refuses (P1-9c experiment E1), so only a read-back
 *            proves the session will open.
 *   sidecar  the session grants (decision 043), or no file.
 *   stub     last and atomic, with `origin`: the host's commit. The
 *            migration's commit is Main's index transaction (P1-9d).
 *
 * The source is never written, renamed, locked or even reopened for more
 * than a read. A failure leaves at most an orphan log and a sidecar with no
 * stub, which the next attempt takes or steps past. A stub already there is
 * replaced only when it is an earlier migration nothing was said in since;
 * any other one is `seed_stub_conflict`.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import { SESSION_MAX_BYTES } from '../../shared/legacyPiSession/codec.ts';
import {
  bindSeedImages,
  checkSeed,
  convertPiSessionBytes,
  type DshSeedEvent,
  SEED_CONVERTER_VERSION,
  type SeedConversion,
  type SeedImage,
} from '../../shared/legacyPiSession/convert/index.ts';
import type { PersistedGrants } from '../../shared/permissions/grants.ts';
import type {
  DshHostSeedSessionRequest,
  DshSeedSessionResult,
  DshSeedStage,
} from '../../shared/types/dshHostProtocol.ts';
import { WORKER_ATTACHMENT_REJECTED } from '../../shared/types/workerRpc.ts';
import { admitUserContent, type DshAttachmentStore } from './attachments.ts';
import { dshSessionIdFor, hasNamedError } from './dshSessionRuntime.ts';
import { writeGrantSidecar } from './grantStore.ts';
import type { DshSessionQuery } from './historyCache.ts';
import { nextSuffixNumber, readSessionEvents } from './lineage.ts';
import { DSH_SESSION_SETUP_EVENTS } from './sessionGc.ts';
import {
  grantsSidecarFor,
  readStub,
  SAFE_SESSION_ID,
  SESSION_STUB_VERSION,
  type SessionStub,
  type SessionStubOrigin,
  stubPathFor,
  writeStubAtomically,
} from './stub.ts';

/** The request's own fields: `seedSession` without its envelope. */
export type SeedSessionRequest = Omit<DshHostSeedSessionRequest, 'host' | 'id'>;

/** Where a migration stopped, in the protocol's words (`DshHostSeeded.error`). */
export class SeedSessionError extends Error {
  readonly stage: DshSeedStage;
  readonly code: string;
  readonly retryable: boolean;

  constructor(stage: DshSeedStage, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'SeedSessionError';
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
  }
}

/** The file is gone. */
export const SOURCE_MISSING = 'source_missing';
/** The file changed under the read, or no longer matches Main's stat. */
export const SOURCE_BUSY = 'source_busy';
/** Past the 32 MiB every 1.0.x reader refused. */
export const SOURCE_TOO_LARGE = 'source_too_large';
/** Not a regular file, or a read error other than the ones above. */
export const SOURCE_UNREADABLE = 'source_unreadable';
/** 1.0.x's code for a legacy file changed after its native copy was made. */
export const SESSION_IMPORT_SOURCE_CHANGED = 'session_import_source_changed';
/** The logical id cannot name a DSH session. */
export const SEED_LOGICAL_ID_INVALID = 'seed_logical_id_invalid';
/** A stub for this chat that is not an earlier migration of it nothing was said in. */
export const SEED_STUB_CONFLICT = 'seed_stub_conflict';
/** DSH refused the seed or the create failed. */
export const SEED_CREATE_FAILED = 'seed_create_failed';
/** Every candidate id is taken by another log. */
export const SEED_ID_EXHAUSTED = 'seed_id_exhausted';
/** DSH could not read the new session back. */
export const SEED_READBACK_FAILED = 'seed_readback_failed';
/** DSH read back something other than the seed. */
export const SEED_READBACK_MISMATCH = 'seed_readback_mismatch';
/** The image store failed for another reason than refusing an image. */
export const SEED_ADMIT_FAILED = 'seed_admit_failed';
export const SEED_SIDECAR_FAILED = 'seed_sidecar_failed';
export const SEED_STUB_FAILED = 'seed_stub_failed';

/** Suffix letter of a migration's DSH session id past the first: `aiclient-<id>_m<n>`. */
export const MIGRATION_SUFFIX_LETTER = 'm';
/** First `_m<n>`, and how many candidates a migration tries. */
const FIRST_MIGRATION_SUFFIX = 2;
const MIGRATION_ID_ATTEMPTS = 20;

/** 1.0.x's name for the native copy it made beside a legacy file (`legacy.ts` `prepareSessionConfig`). */
const NATIVE_COPY_SUFFIX = '.native-v4.jsonl';

/** An agent handle, narrowed to what a migration uses. */
interface SeedAgentHandle {
  readonly agent: { readonly session: unknown };
  dispose(): Promise<void>;
}

/** What a migration takes from the host, injected so it runs without DSH. */
export interface SeedSessionDeps {
  /** `$DSH_HOME`: where the stub and its sidecar go. */
  home: string;
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string };
      seed: readonly DshSeedEvent[];
      agentOptions: { provider: string; model: string };
    }): Promise<SeedAgentHandle>;
  };
  sessions: { flush(session: unknown): Promise<boolean> };
  query: DshSessionQuery;
  attachments: DshAttachmentStore;
  /** The agent options a created session is opened with; no turn runs on it here. */
  selection(): { provider: string; model: string };
  now?: () => number;
  /** Past this many bytes a source is refused before it is read (tests lower it). */
  maxSourceBytes?: number;
  /** Writers, injected for failure tests. */
  writeStub?: (file: string, stub: SessionStub) => void;
  writeGrants?: (file: string, record: PersistedGrants) => boolean;
  log?: (...args: unknown[]) => void;
}

// ---- reading the source --------------------------------------------------------

interface SourceBytes {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  mtimeMs: number;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function readFailure(file: string, error: unknown): SeedSessionError {
  if (error instanceof SeedSessionError) return error;
  if (errnoOf(error) === 'ENOENT') {
    return new SeedSessionError('read', SOURCE_MISSING, `No session file at ${file}`);
  }
  return new SeedSessionError(
    'read',
    SOURCE_UNREADABLE,
    `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * The whole file, read once through a read-only handle, between two stats
 * that must agree. Nothing here writes, renames, locks or touches it.
 */
async function readSourceBytes(
  file: string,
  maxBytes: number,
  expect?: { bytes: number; mtimeMs: number }
): Promise<SourceBytes> {
  try {
    const before = await stat(file);
    if (!before.isFile()) {
      throw new SeedSessionError('read', SOURCE_UNREADABLE, `Not a regular file: ${file}`);
    }
    if (expect && (before.size !== expect.bytes || before.mtimeMs !== expect.mtimeMs)) {
      throw new SeedSessionError(
        'read',
        SOURCE_BUSY,
        `${file} changed since Main looked at it`,
        true
      );
    }
    if (before.size > maxBytes) {
      throw new SeedSessionError(
        'read',
        SOURCE_TOO_LARGE,
        `${file} is ${before.size} bytes, past ${maxBytes}`
      );
    }
    const handle = await open(file, 'r');
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    const after = await stat(file);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytes.length !== before.size
    ) {
      throw new SeedSessionError('read', SOURCE_BUSY, `${file} changed while it was read`, true);
    }
    return {
      path: file,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mtimeMs: before.mtimeMs,
    };
  } catch (error) {
    throw readFailure(file, error);
  }
}

/** The first non-empty line as JSON, or undefined when it is not JSON; decodes that line only. */
function firstRowOf(bytes: Uint8Array): Record<string, unknown> | undefined {
  const decoder = new TextDecoder('utf-8');
  let start = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(10, start);
    if (end < 0) end = bytes.length;
    const line = decoder.decode(bytes.subarray(start, end)).trim();
    start = end + 1;
    if (!line) continue;
    try {
      const row = JSON.parse(line) as unknown;
      return typeof row === 'object' && row !== null && !Array.isArray(row)
        ? (row as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Bytes to convert: the file, or for a legacy one the 1.0.x copy beside it,
 * checked as 1.0.x checked it (the copy names the file's real path and the
 * sha256 of its bytes). `realSource` is the file's real path, which the
 * legacy converter derives positional ids from, as 1.0.x's did.
 */
async function resolveConverted(
  named: SourceBytes,
  maxBytes: number
): Promise<{ converted: SourceBytes; from: 'source' | 'native-v4-copy'; realSource: string }> {
  let realSource: string;
  try {
    realSource = await realpath(named.path);
  } catch (error) {
    throw readFailure(named.path, error);
  }
  const first = firstRowOf(named.bytes);
  const legacy = first?.type === 'session' && !(first.kind === 'header' && first.version === 4);
  if (!legacy) return { converted: named, from: 'source', realSource };
  const copyPath = `${realSource}${NATIVE_COPY_SUFFIX}`;
  try {
    await stat(copyPath);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { converted: named, from: 'source', realSource };
    throw readFailure(copyPath, error);
  }
  const copy = await readSourceBytes(copyPath, maxBytes);
  const metadata = firstRowOf(copy.bytes)?.metadata as Record<string, unknown> | undefined;
  if (metadata?.importedFrom !== realSource || metadata?.sourceSha256 !== named.sha256) {
    throw new SeedSessionError(
      'read',
      SESSION_IMPORT_SOURCE_CHANGED,
      'legacy source changed since the native copy was created'
    );
  }
  return { converted: copy, from: 'native-v4-copy', realSource };
}

// ---- the DSH session -----------------------------------------------------------

/** JSON with sorted keys: DSH's frozen copies need not keep the seed's key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item as Record<string, unknown>)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]])
        )
      : item
  );
}

/**
 * A log that is this seed and nothing said since: the seed event for event,
 * its `session/end-seed`, then at most the setup events DSH writes when it
 * opens an agent.
 */
export function holdsExactlySeed(
  events: readonly DshLogEvent[],
  seed: readonly DshSeedEvent[]
): boolean {
  if (events.length <= seed.length || events[seed.length]?.type !== 'session/end-seed') {
    return false;
  }
  for (let index = 0; index < seed.length; index += 1) {
    if (canonical(events[index]) !== canonical(seed[index])) return false;
  }
  return events.slice(seed.length + 1).every((event) => DSH_SESSION_SETUP_EVENTS.has(event.type));
}

/** Whether anything was said in a session after its seed: a turn past the last seed marker. */
function spokenIn(events: readonly DshLogEvent[]): boolean {
  let boundary = -1;
  events.forEach((event, index) => {
    if (event.type === 'session/end-seed') boundary = index;
  });
  return events.slice(boundary + 1).some((event) => event.type === 'turn/start');
}

/** The session's events, or why DSH would not read them: `missing` (not on disk) or `unreadable`. */
async function tryReadSession(
  query: DshSessionQuery,
  dshSessionId: string
): Promise<DshLogEvent[] | 'missing' | 'unreadable'> {
  try {
    return await readSessionEvents(query, dshSessionId);
  } catch (error) {
    return hasNamedError(error, 'SessionPersistenceNotFoundError') ? 'missing' : 'unreadable';
  }
}

function sameOrigin(
  origin: SessionStubOrigin | undefined,
  conversion: SeedConversion,
  named: SourceBytes
): boolean {
  if (origin?.kind !== 'pi-session' || conversion.origin.kind !== 'pi-session') return false;
  return (
    origin.converterVersion === SEED_CONVERTER_VERSION &&
    origin.sourceSha256 === conversion.origin.sourceSha256 &&
    origin.file?.sha256 === named.sha256
  );
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The stub at `file`, undefined when there is none; a file that is not a stub is a conflict. */
function existingStub(file: string): SessionStub | undefined {
  try {
    return readStub(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'dsh_session_missing') return undefined;
    throw new SeedSessionError(
      'stub',
      SEED_STUB_CONFLICT,
      `${file} is there and is not a DSH session identity`
    );
  }
}

/** Each image through the send path's single entry; a refused one stays unbound (placeholder text). */
async function admitImages(
  store: DshAttachmentStore,
  images: readonly SeedImage[]
): Promise<{
  refs: Map<string, Record<string, unknown> | null>;
  admitted: number;
  refused: number;
}> {
  const refs = new Map<string, Record<string, unknown> | null>();
  let admitted = 0;
  let refused = 0;
  for (const image of images) {
    try {
      const [part] = await admitUserContent(store, '', [
        {
          kind: 'image',
          mediaType: image.mediaType,
          data: image.data,
          ...(image.name ? { name: image.name } : {}),
        },
      ]);
      if (part?.type !== 'image') throw new Error('the store admitted no image block');
      refs.set(image.key, { ...part.attachment });
      admitted += 1;
    } catch (error) {
      if ((error as { code?: unknown }).code !== WORKER_ATTACHMENT_REJECTED) {
        throw new SeedSessionError(
          'admit',
          SEED_ADMIT_FAILED,
          `Image admission failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      refs.set(image.key, null);
      refused += 1;
    }
  }
  return { refs, admitted, refused };
}

/** Lets the host's other work run between stages (plan P1-9 §4.3). */
function yieldTurn(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

/**
 * The DSH session for `seed`: a new one, flushed and released, or a log an
 * earlier attempt left under a candidate id holding exactly this seed.
 */
async function createSession(
  deps: SeedSessionDeps,
  base: string,
  avoid: ReadonlySet<string>,
  cwd: string,
  seed: readonly DshSeedEvent[]
): Promise<string> {
  const first = nextSuffixNumber(base, MIGRATION_SUFFIX_LETTER, avoid, FIRST_MIGRATION_SUFFIX);
  for (let attempt = 0; attempt < MIGRATION_ID_ATTEMPTS; attempt += 1) {
    const id = attempt === 0 ? base : `${base}_${MIGRATION_SUFFIX_LETTER}${first + attempt - 1}`;
    if (avoid.has(id)) continue;
    let handle: SeedAgentHandle;
    try {
      handle = await deps.agents.create({
        sessionId: id,
        meta: { cwd },
        seed,
        agentOptions: deps.selection(),
      });
    } catch (error) {
      if (!hasNamedError(error, 'SessionAlreadyExistsError')) {
        throw new SeedSessionError(
          'create',
          SEED_CREATE_FAILED,
          `DSH did not create ${id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // An earlier attempt reached the disk under this id and went no further.
      const events = await tryReadSession(deps.query, id);
      if (Array.isArray(events) && holdsExactlySeed(events, seed)) return id;
      continue;
    }
    try {
      await deps.sessions.flush(handle.agent.session);
    } catch (error) {
      throw new SeedSessionError(
        'create',
        SEED_CREATE_FAILED,
        `DSH did not flush ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      // Released before the read-back: the chat's first resume takes the lock.
      await handle.dispose().catch((error: unknown) => {
        deps.log?.('[dsh-bridge] migrated session dispose failed', id, error);
      });
    }
    return id;
  }
  throw new SeedSessionError(
    'create',
    SEED_ID_EXHAUSTED,
    `Every candidate id for ${base} is taken by another log`
  );
}

// ---- the migration -----------------------------------------------------------------

/** One pi session file made a DSH session (see the module comment); throws `SeedSessionError`. */
export async function seedPiSession(
  deps: SeedSessionDeps,
  request: SeedSessionRequest
): Promise<DshSeedSessionResult> {
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxSourceBytes ?? SESSION_MAX_BYTES;
  const base = dshSessionIdFor(request.logicalSessionId);
  if (!SAFE_SESSION_ID.test(base)) {
    throw new SeedSessionError(
      'request',
      SEED_LOGICAL_ID_INVALID,
      `Logical session id cannot name a DSH session: ${request.logicalSessionId}`
    );
  }

  const named = await readSourceBytes(request.sourceFile, maxBytes, request.expect);
  const { converted, from, realSource } = await resolveConverted(named, maxBytes);
  const conversion = convertPiSessionBytes(converted.bytes, {
    sourceFile: from === 'source' ? realSource : converted.path,
    cwd: request.cwd,
  });
  if (!conversion.ok) {
    throw new SeedSessionError(
      conversion.failure.stage,
      conversion.failure.code,
      conversion.message
    );
  }
  const source = { sha256: named.sha256, bytes: named.bytes.length, mtimeMs: named.mtimeMs };
  const answer = (
    stubFile: string,
    dshSessionId: string,
    reused: boolean,
    images: { admitted: number; refused: number }
  ): DshSeedSessionResult => ({
    stubFile,
    dshSessionId,
    reused,
    source,
    converted: from,
    legacyPermissions: conversion.legacyPermissions,
    grants: conversion.grants?.grants.length ?? 0,
    images,
    report: conversion.report,
  });
  await yieldTurn();

  // An earlier migration of this chat: reuse it, replace it, or refuse.
  const stubFile = stubPathFor(deps.home, base);
  const avoid = new Set<string>();
  const earlier = existingStub(stubFile);
  if (earlier) {
    if (earlier.logicalSessionId !== request.logicalSessionId) {
      throw new SeedSessionError(
        'stub',
        SEED_STUB_CONFLICT,
        `${stubFile} belongs to ${earlier.logicalSessionId}`
      );
    }
    const lineage = earlier.lineage ?? [];
    const events = await tryReadSession(deps.query, earlier.dshSessionId);
    if (
      sameOrigin(earlier.origin, conversion, named) &&
      samePath(earlier.cwd, request.cwd) &&
      Array.isArray(events)
    ) {
      return answer(stubFile, earlier.dshSessionId, true, { admitted: 0, refused: 0 });
    }
    // Replaceable only when it is a migration nothing was said in since:
    // its index transaction never committed, so no chat uses it.
    const untouched =
      earlier.origin?.kind === 'pi-session' &&
      lineage.length <= 1 &&
      (!Array.isArray(events) || !spokenIn(events));
    if (!untouched) {
      throw new SeedSessionError(
        'stub',
        SEED_STUB_CONFLICT,
        `${stubFile} is a DSH chat already, not a migration left unfinished`
      );
    }
    deps.log?.('[dsh-bridge] replacing an unfinished migration', earlier.dshSessionId);
    avoid.add(earlier.dshSessionId);
    for (const entry of lineage) avoid.add(entry.dshSessionId);
  }

  const admission = await admitImages(deps.attachments, conversion.images);
  const bound = bindSeedImages(conversion.seed, admission.refs);
  const violations = checkSeed(bound.events, { images: 'bound' });
  if (violations.length > 0) {
    const first = violations[0];
    throw new SeedSessionError(
      'verify',
      'seed_invariant_violated',
      `${first?.rule} at ${String(first?.seq)}: ${first?.message}`
    );
  }
  await yieldTurn();

  const dshSessionId = await createSession(deps, base, avoid, request.cwd, bound.events);
  await yieldTurn();

  const events = await tryReadSession(deps.query, dshSessionId);
  if (!Array.isArray(events)) {
    throw new SeedSessionError(
      'verify',
      SEED_READBACK_FAILED,
      `DSH cannot read ${dshSessionId} back (${events})`
    );
  }
  if (!holdsExactlySeed(events, bound.events)) {
    throw new SeedSessionError(
      'verify',
      SEED_READBACK_MISMATCH,
      `DSH read ${dshSessionId} back as other than its seed`
    );
  }

  const sidecar = grantsSidecarFor(stubFile);
  if (conversion.grants) {
    const writeGrants =
      deps.writeGrants ??
      ((file: string, record: PersistedGrants) => writeGrantSidecar(file, record, deps.log));
    if (!writeGrants(sidecar, conversion.grants)) {
      throw new SeedSessionError(
        'sidecar',
        SEED_SIDECAR_FAILED,
        `The session grants could not be written beside ${stubFile}`,
        true
      );
    }
  } else {
    // A sidecar an unfinished attempt left must not grant anything now.
    rmSync(sidecar, { force: true });
  }

  const at = now();
  const origin: SessionStubOrigin = {
    ...conversion.origin,
    migratedAt: at,
    file: { path: named.path, ...source },
  };
  try {
    (deps.writeStub ?? writeStubAtomically)(stubFile, {
      engine: 'dsh',
      version: SESSION_STUB_VERSION,
      dshSessionId,
      logicalSessionId: request.logicalSessionId,
      cwd: request.cwd,
      createdAt: at,
      lineage: [{ dshSessionId, reason: 'create', at }],
      origin,
    });
  } catch (error) {
    throw new SeedSessionError(
      'stub',
      SEED_STUB_FAILED,
      `The identity stub could not be written: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }
  return answer(stubFile, dshSessionId, false, {
    admitted: admission.admitted,
    refused: admission.refused,
  });
}
