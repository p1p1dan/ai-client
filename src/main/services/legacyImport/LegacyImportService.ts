import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  LegacyImportBatchResult,
  LegacyImportItemResult,
  LegacyImportProject,
  LegacyImportSessionPreview,
  LegacyImportSourceRef,
  SessionIndexEntry,
} from '@shared/types';
import { legacyImportDedupeKey } from '@shared/types';
import { PI_AGENT } from '@shared/types/agentWire';
import { workerManager } from '../agent-host/WorkerManager';
import { sessionIndexService } from '../chat/SessionIndexService';
import { ClaudeSessionScanner, resolveLegacyClaudeSessionRoot } from './ClaudeSessionScanner';
import { ClaudeSourceAdapter } from './ClaudeSourceAdapter';
import { LegacyImportManifest, type LegacyImportManifestRecord } from './LegacyImportManifest';
import type { createPiImport, inspectPiImport, reconcilePiImport } from './PiImportProcess';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export interface LegacyImportServiceOptions {
  scanner?: ClaudeSessionScanner;
  manifest?: LegacyImportManifest;
  sessionIndex?: LegacyImportSessionIndex;
  createImport?: typeof createPiImport;
  inspectImport?: typeof inspectPiImport;
  reconcileImport?: typeof reconcilePiImport;
  createId?: () => string;
  now?: () => number;
}

export class LegacyImportService {
  private readonly scanner: ClaudeSessionScanner;
  private readonly adapter: ClaudeSourceAdapter;
  private readonly manifest: LegacyImportManifest;
  private readonly sessionIndex: LegacyImportSessionIndex;
  private readonly createImport: typeof createPiImport;
  private readonly inspectImport: typeof inspectPiImport;
  private readonly reconcileImport: typeof reconcilePiImport;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly flights = new Map<string, Promise<LegacyImportItemResult>>();
  private reconcilePromise: Promise<void> | null = null;
  private reconciled = false;

  constructor(options: LegacyImportServiceOptions = {}) {
    this.scanner =
      options.scanner ??
      new ClaudeSessionScanner({ resolveRoots: () => [resolveLegacyClaudeSessionRoot()] });
    this.adapter = new ClaudeSourceAdapter(this.scanner);
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
    return this.scanner.scanProjects();
  }

  async listSessions(projectId: string): Promise<LegacyImportSessionPreview[]> {
    await this.reconcile();
    const [sessions, records] = await Promise.all([
      this.scanner.getSessionsForProject(projectId),
      this.manifest.list(),
    ]);
    const counts = new Map<string, number>();
    for (const record of records) {
      if (record.status !== 'complete' || record.source.projectId !== projectId) continue;
      counts.set(
        record.source.sourceSessionId,
        (counts.get(record.source.sourceSessionId) ?? 0) + 1
      );
    }
    return sessions.map((session) => ({
      ...session,
      importedSnapshots: counts.get(session.id) ?? 0,
    }));
  }

  async importBatch(sources: LegacyImportSourceRef[]): Promise<LegacyImportBatchResult> {
    await this.reconcile();
    const unique = new Map<string, LegacyImportSourceRef>();
    for (const source of sources) {
      if (
        source.sourceKind !== 'claude-code' ||
        !source.projectId.trim() ||
        !source.sourceSessionId.trim()
      ) {
        continue;
      }
      unique.set(`${source.sourceKind}:${source.projectId}:${source.sourceSessionId}`, source);
    }
    const results: LegacyImportItemResult[] = [];
    for (const source of unique.values()) {
      results.push(await this.importOne(source));
    }
    return { results };
  }

  private async importOne(source: LegacyImportSourceRef): Promise<LegacyImportItemResult> {
    let read: Awaited<ReturnType<ClaudeSourceAdapter['read']>>;
    try {
      read = await this.adapter.read(source);
    } catch (error) {
      return { source, status: 'failed', error: errorMessage(error) };
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
    read: Awaited<ReturnType<ClaudeSourceAdapter['read']>>
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

    const logicalSessionId = `session-import-${this.createId()}`;
    const targetPiSessionId = `import-${this.createId()}`;
    const record: LegacyImportManifestRecord = {
      dedupeKey,
      status: 'importing',
      source,
      sourcePath: read.sourcePath,
      sourceFingerprint: read.conversation.sourceFingerprint,
      workspacePath: read.conversation.workspacePath,
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
        conversation: read.conversation,
      });
      await this.manifest.updateImporting(dedupeKey, {
        targetSessionFile: imported.result.finalSessionFile,
      });
      await this.adapter.assertUnchanged(read.sourcePath, read.conversation.sourceFingerprint);
      const row: SessionIndexEntry = {
        sessionId: logicalSessionId,
        runtimeIdentity: imported.result.finalSessionFile,
        piLeaf: imported.result.leaf,
        legacyImport: {
          sourceKind: 'claude-code',
          targetPiSessionId,
          dedupeKey,
        },
        agent: PI_AGENT,
        workspacePath: read.conversation.workspacePath,
        title: read.conversation.title,
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
          workspacePath: read.conversation.workspacePath,
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

  private async reconcileInternal(): Promise<void> {
    const records = await this.manifest.list();
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
        const message = `Import cleanup pending: worker inspection: ${errorMessage(error)}`;
        await this.manifest.fail(record.dedupeKey, message, true);
        throw new Error(message);
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
        : 'Recovered and cleaned an interrupted legacy import';
      await this.manifest.fail(record.dedupeKey, cleanupMessage, cleanupErrors.length > 0);
      if (cleanupErrors.length) throw new Error(cleanupMessage);
    }
  }
}

export const legacyImportService = new LegacyImportService();
