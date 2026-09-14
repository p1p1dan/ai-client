/**
 * P5-4 — importing a Claude Code / Codex conversation into a native session.
 *
 * ## Why this exists at all
 *
 * ARD §4.2 lists conversation import as "keep what we have, adapt it to the new
 * session plugin". What was actually there was one implementation, pi's: the
 * import RPCs went through `PiLegacyImportWriter`, which drives
 * `pi-coding-agent`'s `SessionManager`. So importing a single conversation
 * loaded the entire package this evolution exists to remove — on an install
 * that had already switched to the native backend, and for a job with no model
 * call in it whatsoever.
 *
 * ## What is deliberately kept identical to the pi path
 *
 *  - **Staged, then published by rename.** A half-written transcript must never
 *    be visible under the id the session index is about to point at.
 *  - **The two custom entry types** (`aiclient.legacy-import.provenance` and
 *    `.display`). They are what the timeline projector already knows how to
 *    render, so an imported conversation looks the same whichever backend wrote
 *    it, and a conversation imported before this node still opens after it.
 *  - **The display-only leak check.** Rows that exist to be LOOKED at — a tool
 *    call whose result was not preserved, a redacted attachment — must not
 *    reach the model as context. On this backend `buildSessionContext` drops
 *    every `custom` entry that has no projector, so the property holds by
 *    construction; it is asserted anyway, because "holds by construction" stops
 *    being true the day someone adds a projector.
 *  - **"An assistant reply survived".** An import that produced only user turns
 *    is a conversion bug, and it is much cheaper to catch here than to explain
 *    to someone looking at a half-empty transcript.
 */

import { join } from 'node:path';
import { Context } from 'cordis';
import { paginatePiSessionHistory } from '../../agent-host/piSessionTimeline.ts';
import type {
  ImportedConversation,
  ImportedConversationEntry,
  WorkerDiscardImportedSessionResult,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
  WorkerInspectImportedSessionResult,
  WorkerReconcileImportedSessionResult,
} from '../../shared/types/legacyImport.ts';
import {
  LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
  LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
} from '../../shared/types/legacyImport.ts';
import type { RuntimeHostConfig, RuntimeHostIoService } from '../contracts.ts';
import { errorCode, RuntimeHostError } from '../host/errors.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import { JsonlSessionStore } from '../plugins/session/store.ts';
import { writerLockPath } from '../plugins/session/writerLock.ts';

/** Same directory name the pi writer stages in, so a half-done import from
 * either backend is recognisable as one. */
const IMPORT_STAGING_DIR = '.aiclient-import-staging';
const SESSIONS_DIR = 'sessions';

function importError(code: string, message: string): RuntimeHostError {
  return new RuntimeHostError(code, message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

/**
 * Zeroes rather than omissions.
 *
 * `usage` is not optional on an assistant message, and an imported turn has no
 * true figure to report: the tokens were spent in another product, months ago,
 * against a price list we do not have. Zero is the honest reading of "this
 * conversation cost this session nothing" — and it keeps the running total a
 * sum of what THIS app actually spent.
 */
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

function displayData(entry: Extract<ImportedConversationEntry, { kind: 'display' }>) {
  return {
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
}

async function appendConversation(
  store: JsonlSessionStore,
  conversation: ImportedConversation
): Promise<void> {
  await store.appendEntry({
    type: 'custom',
    customType: LEGACY_IMPORT_CUSTOM_TYPE_PROVENANCE,
    data: {
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
    },
  } as never);
  await store.rename(conversation.title);

  for (const entry of conversation.entries) {
    if (entry.kind === 'display') {
      await store.appendEntry({
        type: 'custom',
        customType: LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY,
        data: displayData(entry),
      } as never);
      continue;
    }
    if (entry.kind === 'user') {
      await store.appendMessage({
        role: 'user',
        content: entry.text,
        timestamp: timestamp(entry.timestamp),
      } as never);
      continue;
    }
    if (entry.kind === 'assistant') {
      await store.appendMessage({
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
        // Named rather than left blank: every other assistant row in a native
        // transcript states which provider answered, and an imported one that
        // claimed a real provider would be indistinguishable from a turn this
        // app actually ran.
        api: 'legacy-import',
        provider: 'legacy-import',
        model: entry.model || conversation.model || conversation.sourceKind,
        usage: usageZero(),
        stopReason: 'stop',
        timestamp: timestamp(entry.timestamp),
      } as never);
      continue;
    }
    await store.appendMessage({
      role: 'toolResult',
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      content: [{ type: 'text', text: entry.output }],
      isError: entry.isError,
      timestamp: timestamp(entry.timestamp),
    } as never);
  }
}

function assertUsable(store: JsonlSessionStore): void {
  const snapshot = store.snapshot();
  if (!snapshot.messages.some((message) => message.role === 'assistant')) {
    throw importError(
      'WORKER_IMPORT_VALIDATION_FAILED',
      'Imported session did not retain an assistant response'
    );
  }
  const leaked = snapshot.messages.some(
    (message) =>
      (message as { customType?: unknown }).customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY
  );
  if (leaked) {
    throw importError(
      'WORKER_IMPORT_CONTEXT_LEAK',
      'Display-only legacy entries leaked into model context'
    );
  }
}

export class NativeLegacyImportWriter {
  private publishedFile: string | null = null;
  private readonly agentDir: string;
  private readonly host: RuntimeHostConfig;
  private opened: { ctx: Context; io: RuntimeHostIoService } | null = null;

  /**
   * Takes a host config rather than a ready IO service.
   *
   * The worker entry has no plugin graph at the point it decides which writer
   * to use — `createRuntime` builds one per session, and an import is not a
   * session. Bringing up the two host plugins here keeps every file read and
   * write in this class on the same guarded path as the rest of the runtime
   * (ARD D11), including the encrypted-Windows read fallback, which a plain
   * `node:fs` call would step around.
   */
  constructor(host: RuntimeHostConfig, agentDir: string) {
    this.host = host;
    this.agentDir = agentDir;
  }

  private async io(): Promise<RuntimeHostIoService> {
    if (!this.opened) {
      const ctx = new Context();
      await ctx.plugin(ExecPlugin, this.host);
      const fiber = await ctx.plugin(HostIoPlugin, this.host);
      await fiber.await();
      this.opened = { ctx, io: ctx.runtimeHostIo as RuntimeHostIoService };
    }
    return this.opened.io;
  }

  async dispose(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    if (!opened) return;
    await (opened.io as HostIoPlugin).shutdown();
    await (opened.ctx.runtimeExec as ExecPlugin).shutdown();
    await opened.ctx.fiber.dispose();
  }

  /**
   * Where an imported session lands.
   *
   * Named for the id Main allocated, not for a timestamp: that id is the one
   * thing the manifest, the session index row and a later reconcile all agree
   * on, so it is also the only name `inspectInterrupted` can look for after the
   * process that was writing died.
   */
  private fileFor(dir: string, targetPiSessionId: string): string {
    return join(dir, `${targetPiSessionId}.jsonl`);
  }

  private get sessionsDir(): string {
    return join(this.agentDir, SESSIONS_DIR);
  }

  private get stagingDir(): string {
    return join(this.sessionsDir, IMPORT_STAGING_DIR);
  }

  async create(input: WorkerImportConversationPayload): Promise<WorkerImportConversationResult> {
    if (this.publishedFile) {
      throw importError(
        'WORKER_IMPORT_ALREADY_CREATED',
        'This import worker already published a session'
      );
    }
    await (await this.io()).mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    const stagedSessionFile = this.fileFor(this.stagingDir, input.targetPiSessionId);
    const finalSessionFile = this.fileFor(this.sessionsDir, input.targetPiSessionId);

    try {
      const staged = await JsonlSessionStore.open(await this.io(), {
        file: stagedSessionFile,
        cwd: input.conversation.workspacePath,
        mode: 'create',
        id: input.targetPiSessionId,
      });
      try {
        await appendConversation(staged, input.conversation);
        await staged.flush();
        assertUsable(staged);
        if (staged.snapshot().id !== input.targetPiSessionId) {
          throw importError(
            'WORKER_IMPORT_IDENTITY_MISMATCH',
            'Imported session id changed during staging'
          );
        }
      } finally {
        await staged.close();
      }
      await (await this.io()).rename(stagedSessionFile, finalSessionFile);
    } catch (error) {
      await (await this.io()).unlink(stagedSessionFile).catch(() => undefined);
      if (this.publishedFile === null) {
        await (await this.io()).unlink(finalSessionFile).catch(() => undefined);
      }
      throw error;
    }

    // Reopened rather than trusted: the rename is the publish, and what a
    // reader gets from the published path is the only claim worth returning.
    const published = await JsonlSessionStore.open(await this.io(), {
      file: finalSessionFile,
      cwd: input.conversation.workspacePath,
      mode: 'resume',
    });
    try {
      if (published.snapshot().id !== input.targetPiSessionId) {
        throw importError(
          'WORKER_IMPORT_IDENTITY_MISMATCH',
          'Imported session identity did not survive the atomic publish'
        );
      }
      assertUsable(published);
      this.publishedFile = published.file;
      return {
        logicalSessionId: input.logicalSessionId,
        piSessionId: input.targetPiSessionId,
        workspacePath: input.conversation.workspacePath,
        stagedSessionFile,
        finalSessionFile: published.file,
        leaf: published.metadata().leaf,
        history: {
          logicalSessionId: input.logicalSessionId,
          sessionFile: published.file,
          workspacePath: input.conversation.workspacePath,
          page: paginatePiSessionHistory(published.history()),
        },
      };
    } catch (error) {
      await (await this.io()).unlink(finalSessionFile).catch(() => undefined);
      this.publishedFile = null;
      throw error;
    } finally {
      await published.close();
    }
  }

  /**
   * Every file that still carries this import's id.
   *
   * Both directories, because an import can die between writing the staged file
   * and renaming it — the two are exactly the states a reconcile has to clean
   * up, and looking in only one of them leaves an orphan that blocks the retry
   * with `import destination already exists`.
   *
   * Each directory is checked for the transcript itself AND its writer-lock
   * sidecar (`writerLockPath`, session/writerLock.ts): `JsonlSessionStore.open`
   * takes that lock before the transcript exists and only releases it on a
   * clean `close()`, so a process killed mid-import strands the sidecar right
   * next to the file it was guarding.
   */
  async inspectInterrupted(
    _workspacePath: string,
    targetPiSessionId: string
  ): Promise<WorkerInspectImportedSessionResult> {
    const sessionFiles: string[] = [];
    for (const dir of [this.sessionsDir, this.stagingDir]) {
      const candidate = this.fileFor(dir, targetPiSessionId);
      for (const path of [candidate, writerLockPath(candidate)]) {
        try {
          await (await this.io()).stat(path);
          sessionFiles.push(path);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
    return { sessionFiles };
  }

  /**
   * Removes everything `inspectInterrupted` found, then the staging directory
   * itself if that left it empty.
   *
   * Every candidate gets an unlink attempt regardless of whether an earlier one
   * failed — a transcript that was removable but whose lock sidecar was not (or
   * the reverse) must not leave the removable half behind. Failures are
   * collected and raised together only after every candidate was tried, so the
   * caller still sees a single reconcile error to retry against.
   */
  async reconcileInterrupted(
    workspacePath: string,
    targetPiSessionId: string
  ): Promise<WorkerReconcileImportedSessionResult> {
    const inspected = await this.inspectInterrupted(workspacePath, targetPiSessionId);
    let removedFiles = 0;
    const failures: string[] = [];
    for (const sessionFile of inspected.sessionFiles) {
      try {
        await (await this.io()).unlink(sessionFile);
        removedFiles += 1;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        failures.push(`${sessionFile}: ${errorText(error)}`);
      }
    }
    try {
      await this.removeStagingDirIfEmpty();
    } catch (error) {
      failures.push(`${this.stagingDir}: ${errorText(error)}`);
    }
    if (failures.length > 0) {
      throw importError(
        'WORKER_IMPORT_RECONCILE_FAILED',
        `failed to clean up interrupted import: ${failures.join('; ')}`
      );
    }
    const remaining = await this.inspectInterrupted(workspacePath, targetPiSessionId);
    return { removedFiles, remainingFiles: remaining.sessionFiles.length };
  }

  /**
   * Deletes the staging directory only when nothing else is in it.
   *
   * Other interrupted imports can be staged alongside this one — each writer
   * gets its own id-named file(s), not its own directory — so an unconditional
   * rmdir here would delete a directory a sibling reconcile still needs to find
   * its own leftovers in.
   */
  private async removeStagingDirIfEmpty(): Promise<void> {
    const io = await this.io();
    try {
      for await (const _entry of io.readDirectory(this.stagingDir)) {
        return;
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    try {
      await io.rmdir(this.stagingDir);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
    }
  }

  /**
   * Undo the publish this writer performed, and only that one.
   *
   * Refusing any other path is the point: `discard` is reached from an error
   * path in Main, where the file name comes from a result object that a failed
   * import may have left half-filled. A writer that deleted whatever it was
   * handed would be one bad error path away from removing a live session.
   */
  async discard(sessionFile: string): Promise<WorkerDiscardImportedSessionResult> {
    if (!this.publishedFile || !samePath(this.publishedFile, sessionFile)) {
      return { discarded: false };
    }
    try {
      await (await this.io()).unlink(this.publishedFile);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    this.publishedFile = null;
    return { discarded: true };
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return normalize(left) === normalize(right);
}
