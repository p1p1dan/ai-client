import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  LegacyImportBatchResult,
  LegacyImportItemResult,
  LegacyImportProject,
  LegacyImportSessionPreview,
  LegacyImportSourceKind,
  LegacyImportSourceRef,
  SessionIndexEntry,
} from '@shared/types';
import { legacyImportDedupeKey } from '@shared/types';
import { PI_AGENT } from '@shared/types/agentWire';
import { redactStderrLine } from '../../../agent-host/stderrRedaction';
import { scratchWorkspaceService } from '../agent-host/ScratchWorkspaceService';
import { workerManager } from '../agent-host/WorkerManager';
import { sessionIndexService } from '../chat/SessionIndexService';
import { ClaudeSessionScanner, resolveLegacyClaudeSessionRoot } from './ClaudeSessionScanner';
import { ClaudeImportSourceError } from './ClaudeSourceAdapter';
import { LegacyImportManifest, type LegacyImportManifestRecord } from './LegacyImportManifest';
import {
  type ConvertedLegacySource,
  claudeSourceImporter,
  codexSourceImporter,
  type LegacySourceImporter,
  scanAllLegacySources,
} from './LegacyImportSources';
import type { createPiImport, inspectPiImport, reconcilePiImport } from './PiImportProcess';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * T067 (D9): the failed-item fields, message and machine-readable code alike.
 *
 * The message is unchanged and still the fallback — only refusals that carry a
 * `failure` (the two source-size ceilings) gain a code, and only because the
 * renderer has a Chinese sentence and a next step to offer for those two.
 */
function failureFields(
  error: unknown
): Pick<LegacyImportItemResult, 'error' | 'errorCode' | 'errorParams'> {
  const message = errorMessage(error);
  if (error instanceof ClaudeImportSourceError && error.failure) {
    return { error: message, errorCode: error.failure.code, errorParams: error.failure.params };
  }
  return { error: message };
}

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export interface LegacyImportSessionIndex {
  get(sessionId: string): Promise<SessionIndexEntry | undefined>;
  createImported(entry: SessionIndexEntry): Promise<SessionIndexEntry>;
  removeImported(
    sessionId: string,
    runtimeIdentity: string,
    targetPiSessionId: string
  ): Promise<boolean>;
}

/**
 * H/21 C3 — where an imported conversation is allowed to live.
 *
 * Kept behind an interface so tests can drive the fallback without touching the
 * real temp directory, and so the production wiring stays the one service that
 * owns scratch directories.
 */
export interface LegacyImportWorkspaceFallback {
  /** Allocate (or reuse) this session's isolated scratch directory. */
  ensure(sessionId: string): Promise<string>;
  /** Is this path one of ours? Main derives the row's `unbound` flag from it. */
  isScratchPath(candidate: string): boolean;
}

export interface LegacyImportServiceOptions {
  scanner?: ClaudeSessionScanner;
  importers?: LegacySourceImporter[];
  manifest?: LegacyImportManifest;
  sessionIndex?: LegacyImportSessionIndex;
  createImport?: typeof createPiImport;
  inspectImport?: typeof inspectPiImport;
  reconcileImport?: typeof reconcilePiImport;
  createId?: () => string;
  now?: () => number;
  workspaceFallback?: LegacyImportWorkspaceFallback;
  directoryExists?: (candidate: string) => Promise<boolean>;
}

async function realDirectoryExists(candidate: string): Promise<boolean> {
  if (!candidate.trim()) return false;
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export class LegacyImportService {
  private readonly importers: LegacySourceImporter[];
  private readonly manifest: LegacyImportManifest;
  private readonly sessionIndex: LegacyImportSessionIndex;
  private readonly createImport: typeof createPiImport;
  private readonly inspectImport: typeof inspectPiImport;
  private readonly reconcileImport: typeof reconcilePiImport;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly workspaceFallback: LegacyImportWorkspaceFallback;
  private readonly directoryExists: (candidate: string) => Promise<boolean>;
  private readonly flights = new Map<string, Promise<LegacyImportItemResult>>();
  private reconcilePromise: Promise<void> | null = null;
  private reconciled = false;

  constructor(options: LegacyImportServiceOptions = {}) {
    const scanner =
      options.scanner ??
      new ClaudeSessionScanner({ resolveRoots: () => [resolveLegacyClaudeSessionRoot()] });
    this.importers = options.importers ?? [
      claudeSourceImporter(scanner),
      ...(options.scanner ? [] : [codexSourceImporter()]),
    ];
    this.manifest = options.manifest ?? new LegacyImportManifest();
    this.sessionIndex = options.sessionIndex ?? sessionIndexService;
    this.createImport =
      options.createImport ?? ((payload) => workerManager.createLegacyImport(payload));
    this.inspectImport =
      options.inspectImport ?? ((payload) => workerManager.inspectLegacyImport(payload));
    this.reconcileImport =
      options.reconcileImport ?? ((payload) => workerManager.reconcileLegacyImport(payload));
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.workspaceFallback = options.workspaceFallback ?? scratchWorkspaceService;
    this.directoryExists = options.directoryExists ?? realDirectoryExists;
  }

  /**
   * Decide the working directory the imported session runs in.
   *
   * Keeping the recorded directory is the good outcome: the conversation stays
   * attached to the project it is about. It is only possible when that folder
   * is still on disk AND the caller matched it to a registered workspace —
   * otherwise the row would merge into the sidebar with no workspace to hang
   * off and disappear (`mergeSessionIndex` drops such rows as orphans), which
   * is the failure this fallback exists to prevent.
   *
   * The fallback is an isolated scratch directory, i.e. exactly what an
   * "unbound" chat already uses. The conversation itself is unaffected — the
   * JSONL lives under the agent directory, not under the cwd.
   */
  private async resolveWorkspace(
    source: LegacyImportSourceRef,
    recordedPath: string,
    logicalSessionId: string
  ): Promise<string> {
    const matched = source.workspaceMatched !== false;
    if (matched && (await this.directoryExists(recordedPath))) return recordedPath;
    return this.workspaceFallback.ensure(logicalSessionId);
  }

  reconcile(): Promise<void> {
    if (this.reconciled) return Promise.resolve();
    if (!this.reconcilePromise) {
      this.reconcilePromise = this.reconcileInternal()
        .then(() => {
          this.reconciled = true;
        })
        .finally(() => {
          this.reconcilePromise = null;
        });
    }
    return this.reconcilePromise;
  }

  async listProjects(): Promise<LegacyImportProject[]> {
    await this.reconcile();
    return scanAllLegacySources(this.importers);
  }

  async listSessions(
    projectId: string,
    sourceKind: LegacyImportSourceKind = 'claude-code'
  ): Promise<LegacyImportSessionPreview[]> {
    await this.reconcile();
    const importer = this.importers.find((item) => item.source === sourceKind);
    if (!importer) return [];
    const [scan, records] = await Promise.all([importer.scan(projectId), this.manifest.list()]);
    const counts = new Map<string, number>();
    for (const record of records) {
      if (
        record.status !== 'complete' ||
        record.source.projectId !== projectId ||
        record.source.sourceKind !== sourceKind
      )
        continue;
      counts.set(
        record.source.sourceSessionId,
        (counts.get(record.source.sourceSessionId) ?? 0) + 1
      );
    }
    return scan.sessions.map((session) => ({
      ...session,
      importedSnapshots: counts.get(session.id) ?? 0,
    }));
  }

  /**
   * T066 (D10) — the batch says what it is about to do, and what came of it.
   *
   * The 2026-09-17 field pass ran 42 successful imports and 2 guard rejections
   * and found not one line about any of them in any log: every exit of this
   * service was either a return value the renderer consumed or a `catch` that
   * turned into an item status. Three lines cover it — one when the batch
   * starts, one per failed item (the only place the reason exists at all), one
   * when it ends — and none of them carries conversation content: a source ref
   * is a project id plus a session id, not a transcript.
   */
  async importBatch(sources: LegacyImportSourceRef[]): Promise<LegacyImportBatchResult> {
    await this.reconcile();
    const unique = new Map<string, LegacyImportSourceRef>();
    for (const source of sources) {
      if (
        !this.importers.some((importer) => importer.source === source.sourceKind) ||
        !source.projectId.trim() ||
        !source.sourceSessionId.trim()
      ) {
        continue;
      }
      unique.set(`${source.sourceKind}:${source.projectId}:${source.sourceSessionId}`, source);
    }
    console.log(
      `[legacy-import] Batch started: ${unique.size} session(s) from ${sources.length} requested.`
    );
    const results: LegacyImportItemResult[] = [];
    for (const source of unique.values()) {
      const result = await this.importOne(source);
      if (result.status === 'failed') {
        console.warn(
          `[legacy-import] Failed ${source.sourceKind} session ${source.sourceSessionId}: ${redactStderrLine(result.error ?? 'unknown error')}`
        );
      }
      results.push(result);
    }
    const imported = results.filter((item) => item.status === 'imported').length;
    const already = results.filter((item) => item.status === 'already-imported').length;
    const failed = results.filter((item) => item.status === 'failed').length;
    console.log(
      `[legacy-import] Batch done: ${imported} imported, ${already} already imported, ${failed} failed.`
    );
    return { results };
  }

  private async importOne(source: LegacyImportSourceRef): Promise<LegacyImportItemResult> {
    let read: ConvertedLegacySource;
    try {
      const importer = this.importers.find((item) => item.source === source.sourceKind);
      if (!importer) throw new Error('Unsupported legacy import source');
      read = await importer.convert(source);
    } catch (error) {
      return { source, status: 'failed', ...failureFields(error) };
    }
    const dedupeKey = legacyImportDedupeKey(read.conversation);
    const existingFlight = this.flights.get(dedupeKey);
    if (existingFlight) return existingFlight;
    const promise = this.importReadConversation(source, dedupeKey, read).finally(() => {
      if (this.flights.get(dedupeKey) === promise) this.flights.delete(dedupeKey);
    });
    this.flights.set(dedupeKey, promise);
    return promise;
  }

  private async importReadConversation(
    source: LegacyImportSourceRef,
    dedupeKey: string,
    read: ConvertedLegacySource
  ): Promise<LegacyImportItemResult> {
    const existing = await this.manifest.get(dedupeKey);
    if (existing?.status === 'complete' && existing.targetSessionFile) {
      const [indexed, inspected] = await Promise.all([
        this.sessionIndex.get(existing.logicalSessionId),
        this.inspectImport({
          logicalSessionId: existing.logicalSessionId,
          workspacePath: existing.workspacePath,
          targetPiSessionId: existing.targetPiSessionId,
        }),
      ]);
      if (
        indexed?.runtimeIdentity === existing.targetSessionFile &&
        indexed.legacyImport?.targetPiSessionId === existing.targetPiSessionId &&
        indexed.legacyImport.dedupeKey === dedupeKey &&
        inspected.sessionFiles.some((file) => sameFilePath(file, existing.targetSessionFile ?? ''))
      ) {
        return { source, status: 'already-imported', session: indexed };
      }
    }

    const logicalSessionId = `session-import-${source.sourceKind}-${this.createId()}`;
    const targetPiSessionId = `import-${source.sourceKind}-${this.createId()}`;
    let workspacePath: string;
    try {
      workspacePath = await this.resolveWorkspace(
        source,
        read.conversation.workspacePath,
        logicalSessionId
      );
    } catch (error) {
      return { source, status: 'failed', error: errorMessage(error) };
    }
    // Everything downstream — the worker cwd, the Pi session directory, the
    // index row, crash reconciliation — must agree on one path, so the
    // conversation carries the resolved one from here on.
    const conversation = { ...read.conversation, workspacePath };
    const unbound = this.workspaceFallback.isScratchPath(workspacePath);
    const record: LegacyImportManifestRecord = {
      dedupeKey,
      status: 'importing',
      source,
      sourcePath: read.sourcePath,
      sourceFingerprint: read.conversation.sourceFingerprint,
      workspacePath,
      title: read.conversation.title,
      logicalSessionId,
      targetPiSessionId,
      startedAt: this.now(),
    };

    try {
      await this.manifest.reserve(record);
    } catch (error) {
      const reserved = await this.manifest.get(dedupeKey);
      if (reserved?.status === 'complete' && reserved.targetSessionFile) {
        const indexed = await this.sessionIndex.get(reserved.logicalSessionId);
        if (indexed) return { source, status: 'already-imported', session: indexed };
      }
      return { source, status: 'failed', error: errorMessage(error) };
    }

    let imported: Awaited<ReturnType<typeof createPiImport>> | null = null;
    let indexCommitted = false;
    try {
      imported = await this.createImport({
        logicalSessionId,
        targetPiSessionId,
        conversation,
      });
      await this.manifest.updateImporting(dedupeKey, {
        targetSessionFile: imported.result.finalSessionFile,
      });
      await read.assertUnchanged();
      const row: SessionIndexEntry = {
        sessionId: logicalSessionId,
        runtimeIdentity: imported.result.finalSessionFile,
        piLeaf: imported.result.leaf,
        legacyImport: {
          sourceKind: source.sourceKind,
          targetPiSessionId,
          dedupeKey,
        },
        agent: PI_AGENT,
        // U05-c: only Main may call a session unbound, and it says so only
        // because it is the one that put the session in a scratch directory.
        ...(unbound ? { unbound: true } : {}),
        workspacePath,
        title: conversation.title,
        updatedAt: this.now(),
        archived: false,
      };
      const indexed = await this.sessionIndex.createImported(row);
      indexCommitted = true;
      await this.manifest.complete(dedupeKey, imported.result.finalSessionFile);
      await imported.dispose().catch((disposeError) => {
        console.warn(
          '[legacy-import] Committed import worker disposal failed:',
          errorMessage(disposeError)
        );
      });
      return { source, status: 'imported', session: indexed };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (imported) {
        if (indexCommitted) {
          try {
            const removed = await this.sessionIndex.removeImported(
              logicalSessionId,
              imported.result.finalSessionFile,
              targetPiSessionId
            );
            if (!removed) cleanupErrors.push('failed to remove the committed import index row');
          } catch (cleanupError) {
            cleanupErrors.push(`index cleanup: ${errorMessage(cleanupError)}`);
          }
        }
        try {
          const discarded = await imported.discard();
          if (!discarded) cleanupErrors.push('import worker did not confirm target cleanup');
        } catch (cleanupError) {
          cleanupErrors.push(`target cleanup: ${errorMessage(cleanupError)}`);
        }
        await imported.dispose().catch((cleanupError) => {
          cleanupErrors.push(`worker disposal: ${errorMessage(cleanupError)}`);
        });
      }
      let remainingFiles = 0;
      try {
        const reconciled = await this.reconcileImport({
          logicalSessionId,
          workspacePath,
          targetPiSessionId,
        });
        remainingFiles = reconciled.remainingFiles;
      } catch (cleanupError) {
        cleanupErrors.push(`worker reconciliation: ${errorMessage(cleanupError)}`);
      }
      const remainingRow = await this.sessionIndex.get(logicalSessionId);
      if (remainingRow) cleanupErrors.push('import index row remains discoverable');
      if (remainingFiles > 0) cleanupErrors.push('import target file remains discoverable');
      const combined = [errorMessage(error), ...cleanupErrors].join('; ');
      await this.manifest
        .fail(dedupeKey, combined, cleanupErrors.length > 0)
        .catch(() => undefined);
      if (cleanupErrors.length > 0) this.reconciled = false;
      return { source, status: 'failed', error: combined };
    }
  }

  /**
   * Reconciles every unresolved record, not just the first one.
   *
   * import-catalog-10: this used to `throw` from inside the loop, so a single
   * record that could never be cleaned up (e.g. a persistently read-only index
   * row) wedged every later record behind it forever — each retry replayed the
   * list in the same order and re-failed on the same first record. Failures
   * are now collected per record and the loop always runs to completion; the
   * fail-closed behaviour (subsequent imports stay blocked while anything is
   * unresolved) is preserved by throwing once, after every record had its
   * chance to clean up.
   */
  private async reconcileInternal(): Promise<void> {
    const records = await this.manifest.list();
    const unresolved: string[] = [];
    for (const record of records) {
      if (
        record.status === 'complete' ||
        (record.status === 'failed' && record.cleanupPending === false)
      ) {
        continue;
      }

      let ownedFiles: string[];
      try {
        const inspected = await this.inspectImport({
          logicalSessionId: record.logicalSessionId,
          workspacePath: record.workspacePath,
          targetPiSessionId: record.targetPiSessionId,
        });
        ownedFiles = inspected.sessionFiles;
      } catch (error) {
        const detail = `worker inspection: ${errorMessage(error)}`;
        await this.manifest.fail(record.dedupeKey, `Import cleanup pending: ${detail}`, true);
        unresolved.push(`${record.dedupeKey}: ${detail}`);
        continue;
      }
      const ownsFile = (candidate: string | undefined): candidate is string =>
        typeof candidate === 'string' && ownedFiles.some((owned) => sameFilePath(owned, candidate));
      const row = await this.sessionIndex.get(record.logicalSessionId);

      if (
        record.status === 'importing' &&
        row?.runtimeIdentity &&
        row.legacyImport?.targetPiSessionId === record.targetPiSessionId &&
        row.legacyImport.dedupeKey === record.dedupeKey &&
        record.targetSessionFile &&
        sameFilePath(row.runtimeIdentity, record.targetSessionFile) &&
        ownsFile(record.targetSessionFile)
      ) {
        await this.manifest.complete(record.dedupeKey, record.targetSessionFile);
        continue;
      }

      const cleanupErrors: string[] = [];
      if (row?.runtimeIdentity) {
        if (
          row.legacyImport?.targetPiSessionId !== record.targetPiSessionId ||
          row.legacyImport.dedupeKey !== record.dedupeKey
        ) {
          cleanupErrors.push('manifest index row is not owned by the target Pi import id');
        } else {
          try {
            const removed = await this.sessionIndex.removeImported(
              record.logicalSessionId,
              row.runtimeIdentity,
              record.targetPiSessionId
            );
            if (!removed) cleanupErrors.push('index row cleanup was not confirmed');
          } catch (error) {
            cleanupErrors.push(`index cleanup: ${errorMessage(error)}`);
          }
        }
      }

      let remainingFiles = ownedFiles.length;
      try {
        const reconciled = await this.reconcileImport({
          logicalSessionId: record.logicalSessionId,
          workspacePath: record.workspacePath,
          targetPiSessionId: record.targetPiSessionId,
        });
        remainingFiles = reconciled.remainingFiles;
      } catch (error) {
        cleanupErrors.push(`worker reconciliation: ${errorMessage(error)}`);
      }

      const remainingRow = await this.sessionIndex.get(record.logicalSessionId);
      if (remainingRow) cleanupErrors.push('import index row remains discoverable');
      if (remainingFiles > 0) cleanupErrors.push('import target file remains discoverable');
      const cleanupMessage = cleanupErrors.length
        ? `Import cleanup pending: ${cleanupErrors.join('; ')}`
        : 'Recovered and cleaned an interrupted legacy import run';
      await this.manifest.fail(record.dedupeKey, cleanupMessage, cleanupErrors.length > 0);
      if (cleanupErrors.length) {
        unresolved.push(`${record.dedupeKey}: ${cleanupErrors.join('; ')}`);
      }
    }
    if (unresolved.length) {
      throw new Error(`Import cleanup pending: ${unresolved.join('; ')}`);
    }
  }
}

export const legacyImportService = new LegacyImportService();
