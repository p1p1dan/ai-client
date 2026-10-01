/**
 * dsh-rebase P1-9f (decision 056): the engine half of a Claude Code / Codex
 * import, on the shared DSH host.
 *
 * `LegacyImportService` reads and cleans the source and owns the manifest and
 * the index; this is what it asks of the engine, in three calls:
 *
 *   create     the host seeds the conversation into a new DSH session for
 *              the chat Main minted (`seedSession {kind:'imported-conversation'}`)
 *              and writes its identity stub, named `<target id>.dsh.json`
 *              where the target id is `aiclient-<logical id>` (the value the
 *              ABI field `legacyImport.targetPiSessionId` now carries). The
 *              stub is the index row's `runtimeIdentity`.
 *   inspect    which files of an import are on disk: the stub its target id
 *              names, and the file the manifest recorded. The pi file
 *              (`.jsonl`) of an import 1.0.x made is reported too, so one
 *              1.0.x finished is still recognised as done.
 *   reconcile  an import that never committed loses its stub (and a sidecar
 *              beside it), when the stub is ours: named after the target id and
 *              naming the same chat. Its DSH log stays: it holds the seed, so
 *              the host's collection (P1-3d, decision 024) keeps it, like a
 *              replaced migration's (decision 121). A pi file of a 1.0.x import is
 *              never deleted by this build: unindexed, it shows nowhere here.
 *
 * Nothing here spawns a worker: the 1.0.x pi import worker was deleted in
 * dsh-rebase P1-12 step 1 (decision 147).
 *
 * What leaves this module in an error is the stage and the code
 * (`seedSession`'s, or Main's `host` stage); the host's message can name a
 * path (decision 121 rule 17), so it goes to Main's log only, redacted.
 */

import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  DshHostSeeded,
  DshSeedImportResult,
  DshSeedStage,
} from '@shared/types/dshHostProtocol';
import type { ImportedConversation } from '@shared/types/legacyImport';
import { LEGACY_MIGRATION_MAIN_CODES } from '@shared/types/legacyMigration';
import { app } from 'electron';
import { sanitizeStderrLine } from '../../../agent-host/stderrRedaction';
import { resolveDshHome } from '../agent-host/DshHostProcess';
import { type DshHostSeedImportInput, dshHostSupervisor } from '../agent-host/DshHostSupervisor';
import {
  DSH_GRANTS_SUFFIX,
  DSH_SESSION_ID_PREFIX,
  DSH_STUB_DIR,
  DSH_STUB_SUFFIX,
} from '../agent-host/dshSessionGc';
import { getAppStateRoot } from '../appStatePaths';

/** What `create` is asked to import. */
export interface LegacyImportCreatePayload {
  logicalSessionId: string;
  /** `dshImportTargetId(logicalSessionId)`: the stub's name, recorded before the host is asked. */
  targetPiSessionId: string;
  /** Already carrying the workspace the import resolved: the DSH session's fixed cwd. */
  conversation: ImportedConversation;
}

/** One import as the manifest knows it. */
export interface LegacyImportTarget {
  logicalSessionId: string;
  workspacePath: string;
  targetPiSessionId: string;
  /** The file the manifest recorded, once `create` got that far. */
  targetSessionFile?: string;
}

/** A created import, before its index row commits. */
export interface CreatedLegacyImport {
  /** The identity stub: the row's `runtimeIdentity` and the manifest's `targetSessionFile`. */
  sessionFile: string;
  dshSessionId: string;
  /** The host found this very import already made (an earlier attempt's answer was lost). */
  reused: boolean;
  /** Takes back an import whose row never committed; whether its stub is gone. */
  discard(): Promise<boolean>;
}

export interface LegacyImportInspection {
  /** Files of the import that exist now. */
  sessionFiles: string[];
}

export interface LegacyImportReconciliation {
  removedFiles: number;
  /** Files of this import this build would remove and could not. */
  remainingFiles: number;
}

/** What the importer asks of the engine; `LegacyImportService` takes it injected. */
export interface LegacyImportEngine {
  create(payload: LegacyImportCreatePayload): Promise<CreatedLegacyImport>;
  inspect(target: LegacyImportTarget): Promise<LegacyImportInspection>;
  reconcile(target: LegacyImportTarget): Promise<LegacyImportReconciliation>;
}

/** The supervisor, narrowed to the one call an import makes. */
export interface DshLegacyImportSeeder {
  seedImportedConversation(
    input: DshHostSeedImportInput,
    options?: { userInitiated?: boolean }
  ): Promise<DshHostSeeded<DshSeedImportResult>>;
}

export interface DshLegacyImportHostOptions {
  host?: DshLegacyImportSeeder;
  /** `DSH_HOME` as the host runs it; production resolves it as the launch does. */
  dshHome?: () => string;
  statFile?: (file: string) => Promise<{ isFile(): boolean }>;
  readTextFile?: (file: string) => Promise<string>;
  removeFile?: (file: string) => Promise<void>;
  log?: Pick<Console, 'warn'>;
}

/** Main's own stage for an import, besides the host's. */
export type LegacyImportEngineStage = DshSeedStage | 'host';

/** An import the engine did not make; its message is what the renderer may show. */
export class LegacyImportEngineError extends Error {
  constructor(
    readonly stage: LegacyImportEngineStage,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(
      `Import could not be written by the chat engine (${stage}/${code})` +
        (retryable ? '; it may succeed if tried again' : '')
    );
    this.name = 'LegacyImportEngineError';
  }
}

/** Decision 056: the id the stub of an import is named after, and its DSH session's first candidate. */
export function dshImportTargetId(logicalSessionId: string): string {
  return `${DSH_SESSION_ID_PREFIX}${logicalSessionId}`;
}

/** `<DSH_HOME>/aiclient-sessions/<target id>.dsh.json` (`bridge/stub.ts` `stubPathFor`). */
export function dshImportStubPath(dshHome: string, targetPiSessionId: string): string {
  return path.join(dshHome, DSH_STUB_DIR, `${targetPiSessionId}${DSH_STUB_SUFFIX}`);
}

function productionDshHome(): string {
  return resolveDshHome({ isPackaged: app.isPackaged, appStateRoot: getAppStateRoot() });
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A supervisor rejection (`DshHostSupervisorError.code`) as Main's `host` stage. */
function hostFailure(error: unknown): LegacyImportEngineError {
  switch (errnoOf(error)) {
    case 'DSH_HOST_SEED_TIMEOUT':
      return new LegacyImportEngineError('host', LEGACY_MIGRATION_MAIN_CODES.seedTimeout, true);
    case 'DSH_HOST_SEED_INTERRUPTED':
      return new LegacyImportEngineError('host', LEGACY_MIGRATION_MAIN_CODES.hostExited, true);
    case 'DSH_HOST_SEED_MALFORMED':
      return new LegacyImportEngineError(
        'host',
        LEGACY_MIGRATION_MAIN_CODES.seedAnswerInvalid,
        false
      );
    default:
      return new LegacyImportEngineError('host', LEGACY_MIGRATION_MAIN_CODES.hostUnavailable, true);
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left));
  const b = path.normalize(path.resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class DshLegacyImportHost implements LegacyImportEngine {
  private readonly host: DshLegacyImportSeeder;
  private readonly dshHome: () => string;
  private readonly statFile: NonNullable<DshLegacyImportHostOptions['statFile']>;
  private readonly readTextFile: NonNullable<DshLegacyImportHostOptions['readTextFile']>;
  private readonly removeFile: NonNullable<DshLegacyImportHostOptions['removeFile']>;
  private readonly log: Pick<Console, 'warn'>;

  constructor(options: DshLegacyImportHostOptions = {}) {
    this.host = options.host ?? dshHostSupervisor;
    this.dshHome = options.dshHome ?? productionDshHome;
    this.statFile = options.statFile ?? ((file) => stat(file));
    this.readTextFile = options.readTextFile ?? ((file) => readFile(file, 'utf8'));
    this.removeFile = options.removeFile ?? ((file) => rm(file, { force: true }));
    this.log = options.log ?? console;
  }

  async create(payload: LegacyImportCreatePayload): Promise<CreatedLegacyImport> {
    const { logicalSessionId, targetPiSessionId, conversation } = payload;
    if (targetPiSessionId !== dshImportTargetId(logicalSessionId)) {
      throw new LegacyImportEngineError('request', 'import_target_mismatch', false);
    }
    let answer: DshHostSeeded<DshSeedImportResult>;
    try {
      answer = await this.host.seedImportedConversation(
        { conversation, logicalSessionId, cwd: conversation.workspacePath },
        // An import is the user's action: it may bring a failed host back.
        { userInitiated: true }
      );
    } catch (error) {
      const failure = hostFailure(error);
      this.log.warn(
        `[legacy-import] The chat engine could not import ${logicalSessionId} ` +
          `(${failure.stage}/${failure.code}): ${sanitizeStderrLine(messageOf(error))}`
      );
      throw failure;
    }
    const result = answer.ok ? answer.result : undefined;
    if (!result) {
      const error = answer.error;
      const failure = error
        ? new LegacyImportEngineError(error.stage, error.code, error.retryable)
        : new LegacyImportEngineError('host', LEGACY_MIGRATION_MAIN_CODES.seedAnswerInvalid, false);
      this.log.warn(
        `[legacy-import] The chat engine refused to import ${logicalSessionId} ` +
          `(${failure.stage}/${failure.code})` +
          (error?.message ? `: ${sanitizeStderrLine(error.message)}` : '')
      );
      throw failure;
    }
    const sessionFile = result.stubFile;
    if (path.basename(sessionFile) !== `${targetPiSessionId}${DSH_STUB_SUFFIX}`) {
      // The manifest could not name it after a restart; not an import this build can own.
      await this.removeOwnStub(sessionFile, logicalSessionId).catch(() => false);
      throw new LegacyImportEngineError('stub', 'import_stub_misnamed', false);
    }
    return {
      sessionFile,
      dshSessionId: result.dshSessionId,
      reused: result.reused,
      discard: () => this.removeOwnStub(sessionFile, logicalSessionId),
    };
  }

  async inspect(target: LegacyImportTarget): Promise<LegacyImportInspection> {
    const present: string[] = [];
    for (const file of this.candidates(target)) {
      if (await this.exists(file)) present.push(file);
    }
    return { sessionFiles: present };
  }

  async reconcile(target: LegacyImportTarget): Promise<LegacyImportReconciliation> {
    let removedFiles = 0;
    let remainingFiles = 0;
    for (const file of this.ownedStubs(target)) {
      if (!(await this.exists(file))) continue;
      let outcome: StubRemoval = 'kept';
      try {
        outcome = await this.removeStub(file, target.logicalSessionId);
      } catch (error) {
        this.log.warn(
          `[legacy-import] Could not remove the stub of an unfinished import run: ${sanitizeStderrLine(messageOf(error))}`
        );
      }
      if (outcome === 'removed') removedFiles += 1;
      // One that is not this chat's stub is not counted against this import run.
      else if (outcome === 'kept' && (await this.exists(file))) remainingFiles += 1;
    }
    return { removedFiles, remainingFiles };
  }

  /** Every file of the import worth looking for: its stubs, and the manifest's own record. */
  private candidates(target: LegacyImportTarget): string[] {
    const files = this.ownedStubs(target);
    const recorded = target.targetSessionFile;
    if (recorded && path.isAbsolute(recorded) && !files.some((file) => samePath(file, recorded))) {
      files.push(recorded);
    }
    return files;
  }

  /**
   * The stubs this build may remove for an import: the one its target id
   * names under this `DSH_HOME`, and the manifest's recorded file when that is
   * a stub of the same name (a home that moved since). Never a pi file.
   */
  private ownedStubs(target: LegacyImportTarget): string[] {
    if (target.targetPiSessionId !== dshImportTargetId(target.logicalSessionId)) return [];
    const name = `${target.targetPiSessionId}${DSH_STUB_SUFFIX}`;
    const files = [dshImportStubPath(this.dshHome(), target.targetPiSessionId)];
    const recorded = target.targetSessionFile;
    if (
      recorded &&
      path.isAbsolute(recorded) &&
      path.basename(recorded) === name &&
      !files.some((file) => samePath(file, recorded))
    ) {
      files.push(recorded);
    }
    return files;
  }

  private async exists(file: string): Promise<boolean> {
    try {
      return (await this.statFile(file)).isFile();
    } catch (error) {
      if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return false;
      // Unknown: counted as there, so nothing is taken for cleaned that is not.
      return true;
    }
  }

  /** Takes back one created import: whether its stub is gone now. */
  private async removeOwnStub(file: string, logicalSessionId: string): Promise<boolean> {
    return (await this.removeStub(file, logicalSessionId)) === 'removed';
  }

  /**
   * Removes a stub that names this chat, and a grant sidecar beside it. A file
   * that is gone already counts as removed; one naming another chat, or not a
   * stub at all, is `foreign` and left alone; `kept` is ours and still there.
   */
  private async removeStub(file: string, logicalSessionId: string): Promise<StubRemoval> {
    let text: string;
    try {
      text = await this.readTextFile(file);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return 'removed';
      throw error;
    }
    let stub: { logicalSessionId?: unknown; engine?: unknown };
    try {
      stub = JSON.parse(text) as typeof stub;
    } catch {
      return 'foreign';
    }
    if (stub?.engine !== 'dsh' || stub.logicalSessionId !== logicalSessionId) return 'foreign';
    await this.removeFile(`${file.slice(0, -DSH_STUB_SUFFIX.length)}${DSH_GRANTS_SUFFIX}`);
    await this.removeFile(file);
    return (await this.exists(file)) ? 'kept' : 'removed';
  }
}

type StubRemoval = 'removed' | 'kept' | 'foreign';
