import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  ImportedConversation,
  ImportedConversationEntry,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
} from '../shared/types/legacyImport.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../shared/types/legacyImport.ts';
import type { WorkerHistoryResult } from '../shared/types/workerRpc.ts';
import type { PiSdkModule, PiSessionManager } from './piAgentSessionBootstrap.ts';
import { preflightPiSessionFile, samePiSessionPath } from './piSessionPreflight.ts';
import { readPiSessionHistoryPage } from './piSessionTimeline.ts';
import { readPiLeafCheckpoint } from './piSessionTree.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

const IMPORT_STAGING_DIR = '.aiclient-import-staging';

interface AppendableSessionManager extends PiSessionManager {
  appendMessage?: (message: unknown) => string;
  appendCustomEntry?: (customType: string, data?: unknown) => string;
  appendSessionInfo?: (name: string) => string;
  buildSessionContext?: () => { messages: unknown[]; thinkingLevel?: string; model?: unknown };
}

interface DisplayEntryData {
  version: 1;
  displayKind: string;
  title: string;
  body?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  redacted?: boolean;
  sourceEntryId?: string;
  timestamp?: number;
}

function timestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function usageZero() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function requireAppendable(manager: PiSessionManager): AppendableSessionManager {
  const appendable = manager as AppendableSessionManager;
  if (!appendable.appendMessage || !appendable.appendCustomEntry || !appendable.appendSessionInfo) {
    throw new PiWorkerSessionError(
      'WORKER_IMPORT_UNAVAILABLE',
      'Pi SessionManager does not expose the public append APIs an import requires'
    );
  }
  return appendable;
}

function appendDisplay(
  manager: AppendableSessionManager,
  entry: Extract<ImportedConversationEntry, { kind: 'display' }>
): void {
  const data: DisplayEntryData = {
    version: 1,
    displayKind: entry.displayKind,
    title: entry.title,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.input !== undefined ? { input: entry.input } : {}),
    ...(entry.output !== undefined ? { output: entry.output } : {}),
    ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
    ...(entry.redacted !== undefined ? { redacted: entry.redacted } : {}),
    ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
  };
  manager.appendCustomEntry?.(LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY, data);
}

function appendConversation(
  manager: AppendableSessionManager,
  conversation: ImportedConversation
): void {
  manager.appendCustomEntry?.(LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE, {
    version: 1,
    sourceKind: conversation.sourceKind,
    stableSourceIdentity: conversation.stableSourceIdentity,
    sourceSessionId: conversation.sourceSessionId,
    contentHash: conversation.sourceFingerprint.contentHash,
    schemaVersion: conversation.schemaVersion,
    importerVersion: conversation.importerVersion,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    diagnostics: conversation.diagnostics,
  });
  manager.appendSessionInfo?.(conversation.title);

  for (const entry of conversation.entries) {
    if (entry.kind === 'display') {
      appendDisplay(manager, entry);
      continue;
    }
    if (entry.kind === 'user') {
      manager.appendMessage?.({
        role: 'user',
        content: entry.text,
        timestamp: timestamp(entry.timestamp),
      });
      continue;
    }
    if (entry.kind === 'assistant') {
      manager.appendMessage?.({
        role: 'assistant',
        content: entry.blocks.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.text };
          return {
            type: 'toolCall',
            id: block.toolCallId,
            name: block.name,
            arguments: block.input ?? {},
          };
        }),
        api: 'legacy-import',
        provider: 'legacy-import',
        model: entry.model || conversation.model || 'claude',
        usage: usageZero(),
        stopReason: 'stop',
        timestamp: timestamp(entry.timestamp),
      });
      continue;
    }
    manager.appendMessage?.({
      role: 'toolResult',
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      content: [{ type: 'text', text: entry.output }],
      isError: entry.isError,
      timestamp: timestamp(entry.timestamp),
    });
  }
}

function validatedHistory(
  manager: PiSessionManager,
  logicalSessionId: string,
  sessionFile: string,
  workspacePath: string
): WorkerHistoryResult {
  if (!manager.getBranch) {
    throw new PiWorkerSessionError(
      'WORKER_IMPORT_VALIDATION_FAILED',
      'Imported Pi session does not expose branch history'
    );
  }
  const page = readPiSessionHistoryPage({ getBranch: () => manager.getBranch?.() ?? [] });
  if (!page.messages.some((message) => message.role === 'assistant')) {
    throw new PiWorkerSessionError(
      'WORKER_IMPORT_VALIDATION_FAILED',
      'Imported Pi session did not retain an assistant response'
    );
  }
  return { logicalSessionId, sessionFile, workspacePath, page };
}

export class PiLegacyImportWriter {
  private publishedFile: string | null = null;

  constructor(private readonly loadSdk: () => Promise<unknown>) {}

  async create(input: WorkerImportConversationPayload): Promise<WorkerImportConversationResult> {
    if (this.publishedFile) {
      throw new PiWorkerSessionError(
        'WORKER_IMPORT_ALREADY_CREATED',
        'This import worker already published a Pi session'
      );
    }
    const sdk = (await this.loadSdk()) as PiSdkModule;
    const targetDirProbe = sdk.SessionManager.create(input.conversation.workspacePath);
    const targetDir = targetDirProbe.getSessionDir?.();
    if (!targetDir) {
      throw new PiWorkerSessionError(
        'WORKER_IMPORT_UNAVAILABLE',
        'Pi SessionManager did not return a durable session directory'
      );
    }
    const stagingDir = path.join(targetDir, IMPORT_STAGING_DIR);
    await mkdir(stagingDir, { recursive: true });
    const manager = requireAppendable(
      sdk.SessionManager.create(input.conversation.workspacePath, stagingDir, {
        id: input.targetPiSessionId,
      })
    );
    appendConversation(manager, input.conversation);
    const stagedSessionFile = manager.getSessionFile?.();
    if (!stagedSessionFile) {
      throw new PiWorkerSessionError(
        'WORKER_IMPORT_FILE_MISSING',
        'Pi did not materialize the imported session file'
      );
    }

    const finalSessionFile = path.join(targetDir, path.basename(stagedSessionFile));
    try {
      const stagedHeader = await preflightPiSessionFile(
        stagedSessionFile,
        input.conversation.workspacePath
      );
      if (stagedHeader.sessionId !== input.targetPiSessionId) {
        throw new PiWorkerSessionError(
          'WORKER_IMPORT_IDENTITY_MISMATCH',
          'Imported Pi session id changed during staging'
        );
      }
      const stagedManager = sdk.SessionManager.open(stagedSessionFile);
      if (
        !samePiSessionPath(stagedManager.getSessionFile?.() ?? '', stagedSessionFile) ||
        stagedManager.getSessionId?.() !== input.targetPiSessionId
      ) {
        throw new PiWorkerSessionError(
          'WORKER_IMPORT_IDENTITY_MISMATCH',
          'Pi did not exact-open the staged import file'
        );
      }
      validatedHistory(
        stagedManager,
        input.logicalSessionId,
        stagedSessionFile,
        input.conversation.workspacePath
      );
      const context = (stagedManager as AppendableSessionManager).buildSessionContext?.();
      const displayEntries = stagedManager.getBranch?.().filter((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const record = entry as { type?: unknown; customType?: unknown };
        return record.type === 'custom' && record.customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY;
      });
      const contextMessages = Array.isArray(context?.messages) ? context.messages : [];
      if (
        displayEntries?.some((entry) => contextMessages.includes(entry)) ||
        contextMessages.some((message) => {
          if (typeof message !== 'object' || message === null) return false;
          return (
            (message as { customType?: unknown }).customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY
          );
        })
      ) {
        throw new PiWorkerSessionError(
          'WORKER_IMPORT_CONTEXT_LEAK',
          'Display-only legacy entries leaked into Pi model context'
        );
      }

      await rename(stagedSessionFile, finalSessionFile);
      const finalHeader = await preflightPiSessionFile(
        finalSessionFile,
        input.conversation.workspacePath
      );
      const finalManager = sdk.SessionManager.open(finalSessionFile);
      if (
        finalHeader.sessionId !== input.targetPiSessionId ||
        !samePiSessionPath(finalManager.getSessionFile?.() ?? '', finalSessionFile) ||
        finalManager.getSessionId?.() !== input.targetPiSessionId
      ) {
        throw new PiWorkerSessionError(
          'WORKER_IMPORT_IDENTITY_MISMATCH',
          'Imported Pi session identity did not survive atomic publish'
        );
      }
      const history = validatedHistory(
        finalManager,
        input.logicalSessionId,
        finalSessionFile,
        input.conversation.workspacePath
      );
      this.publishedFile = finalSessionFile;
      await rm(stagingDir, { recursive: false, force: true }).catch(() => undefined);
      return {
        logicalSessionId: input.logicalSessionId,
        piSessionId: input.targetPiSessionId,
        workspacePath: input.conversation.workspacePath,
        stagedSessionFile,
        finalSessionFile,
        leaf: readPiLeafCheckpoint(finalManager),
        history,
      };
    } catch (error) {
      await unlink(stagedSessionFile).catch(() => undefined);
      if (this.publishedFile === null) await unlink(finalSessionFile).catch(() => undefined);
      await rm(stagingDir, { recursive: false, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async inspectInterrupted(
    workspacePath: string,
    targetPiSessionId: string
  ): Promise<{ sessionFiles: string[] }> {
    const sdk = (await this.loadSdk()) as PiSdkModule;
    const targetDir = sdk.SessionManager.create(workspacePath).getSessionDir?.();
    if (!targetDir) {
      throw new PiWorkerSessionError(
        'WORKER_IMPORT_UNAVAILABLE',
        'Pi SessionManager did not return a durable session directory for inspection'
      );
    }
    const suffix = `_${targetPiSessionId}.jsonl`;
    const sessionFiles: string[] = [];
    for (const dir of [targetDir, path.join(targetDir, IMPORT_STAGING_DIR)]) {
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const candidate = path.join(dir, name);
        try {
          const header = await preflightPiSessionFile(candidate, workspacePath);
          if (header.sessionId === targetPiSessionId) sessionFiles.push(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
          if (error instanceof PiWorkerSessionError) continue;
          throw error;
        }
      }
    }
    return { sessionFiles };
  }

  async reconcileInterrupted(
    workspacePath: string,
    targetPiSessionId: string
  ): Promise<{ removedFiles: number; remainingFiles: number }> {
    const inspected = await this.inspectInterrupted(workspacePath, targetPiSessionId);
    let removedFiles = 0;
    for (const sessionFile of inspected.sessionFiles) {
      try {
        await unlink(sessionFile);
        removedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    const remaining = await this.inspectInterrupted(workspacePath, targetPiSessionId);
    return { removedFiles, remainingFiles: remaining.sessionFiles.length };
  }

  async discard(sessionFile: string): Promise<{ discarded: boolean }> {
    if (!this.publishedFile || !samePiSessionPath(this.publishedFile, sessionFile)) {
      return { discarded: false };
    }
    await unlink(this.publishedFile).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    this.publishedFile = null;
    return { discarded: true };
  }
}
