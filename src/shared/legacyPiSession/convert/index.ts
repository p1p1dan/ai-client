// New in dsh-rebase P1-9b

/**
 * pi session / imported conversation → DSH seed (dsh-rebase P1-9b;
 * decisions 052–056, plan P1-9 §4.2 and shard 02).
 *
 * Pure: bytes (or a conversation) in, a verified seed and its report out. No
 * IO, no clock, no randomness, no DSH package. The host (P1-9c `seedSession`)
 * reads the file read-only, calls `convertPiSessionBytes`, admits
 * `images`, calls `bindSeedImages` and `checkSeed(…, {images: 'bound'})`,
 * then `agents.create({seed, meta: {cwd}})`, writes `grants` to the sidecar
 * and `origin` into the stub.
 */

import { createHash } from 'node:crypto';
import type { ImportedConversation } from '../../types/legacyImport.ts';
import { decodeSession, SESSION_MAX_BYTES, type SessionDocument } from '../codec.ts';
import { LegacyPiSessionError } from '../errors.ts';
import { convertLegacySession, firstRow } from '../legacy.ts';
import type { Entry } from '../types.ts';
import { importedConversationIr } from './fromImport.ts';
import { piSessionIr } from './fromPi.ts';
import { checkSeed, seedSurface } from './invariants.ts';
import { buildSeed, type SeedBuild } from './seed.ts';
import {
  type DshSeedEvent,
  SEED_CONVERTER_VERSION,
  type SeedConversionFailure,
  type SeedConversionResult,
  type SeedFailureStage,
  type SeedLossReport,
  type SeedReport,
  type SeedResultReport,
  type SeedSourceReport,
} from './types.ts';

export { LEGACY_IMPORT_PROVIDER } from './assistant.ts';
export { importIdPrefix } from './fromImport.ts';
export { LEGACY_RECOVERED_RESULT_TEXT } from './fromPi.ts';
export { bindSeedImages, imageNotMigratedText } from './images.ts';
export { checkSeed, jsonFault, type SeedViolation, seedSurface } from './invariants.ts';
export {
  CHECKPOINT_PREAMBLE,
  OUTCOME_UNKNOWN_TEXT,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
} from './seed.ts';
export * from './types.ts';

export interface PiSourceInput {
  /**
   * The path the file was read from. Only the legacy converter reads it (v1
   * rows take positional ids from it, as the preview's do); it never enters
   * the seed or the report.
   */
  sourceFile: string;
  /** The session's workspace: the fallback when a legacy header names no cwd. */
  cwd: string;
}

function countBy(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function failed(
  report: SeedReport,
  stage: SeedFailureStage,
  code: string,
  message: string
): SeedConversionFailure {
  const failure = { stage, code };
  return { ok: false, failure, message, report: { ...report, failure } };
}

function errorOf(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof LegacyPiSessionError ? error.code : 'seed_build_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function entryKind(entry: Entry): string {
  if (entry.type === 'message') return `message:${entry.message.role}`;
  if (entry.type !== 'custom') return entry.type;
  const type = entry.customType;
  if (type.startsWith('aiclient.') || type.startsWith('aiclient-') || type === 'permission-tier')
    return `custom:${type}`;
  if (type.startsWith('pi-cli:')) return 'custom:pi-cli:*';
  if (type.startsWith('legacy:')) return 'custom:legacy:*';
  return 'custom:other';
}

/** The last data line was cut mid-write (`codec.ts` truncates it). */
function tornTail(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim());
  const last = lines[lines.length - 1];
  if (last === undefined || lines.length < 2) return false;
  try {
    JSON.parse(last);
    return false;
  } catch {
    return true;
  }
}

function resultReport(
  build: SeedBuild,
  grants: number,
  legacyPermissions: boolean
): SeedResultReport {
  const { counts, events } = build;
  return {
    events: countBy(events.map((event) => event.type)),
    turns: counts.turns,
    steps: counts.steps,
    turnEnds: counts.turnEnds,
    images: build.images.length,
    imageBlocks: counts.imageBlocks,
    ignorable: countBy(events.filter((event) => event.ignorable).map((event) => event.type)),
    checkpoints: {
      keptOriginals: counts.keptOriginals,
      retainedCopies: counts.retainedCopies,
      summaryOnly: counts.summaryOnly,
      appended: counts.appended,
    },
    grants,
    legacyPermissions,
  };
}

function verified(events: readonly DshSeedEvent[]): string | undefined {
  const violations = checkSeed(events);
  if (violations.length === 0) return undefined;
  return violations
    .slice(0, 5)
    .map((violation) => `${violation.rule} at ${violation.seq}: ${violation.message}`)
    .join('; ');
}

/** A decoded pi document (active branch per decision 052) → seed. */
export function convertPiSessionDocument(
  document: SessionDocument,
  source: SeedSourceReport & { sha256Full: string }
): SeedConversionResult {
  const { sha256Full, ...sourceReport } = source;
  const report: SeedReport = { converterVersion: SEED_CONVERTER_VERSION, source: sourceReport };
  let ir: ReturnType<typeof piSessionIr>;
  let build: SeedBuild;
  try {
    ir = piSessionIr(document);
    build = buildSeed(ir.items, { inferInterruptions: true });
  } catch (error) {
    const { code, message } = errorOf(error);
    return failed(report, 'build', code, message);
  }
  report.source.branchEntries = ir.branch.length;
  const { counts } = ir;
  const lossy: SeedLossReport = {
    offBranchEntries: document.entries.length - ir.branch.length,
    offBranchLabels: counts.offBranchLabels,
    labels: counts.labels,
    bookkeeping: counts.bookkeeping,
    sessionName: document.name !== undefined,
    errorReplyBodies: counts.errorReplyBodies,
    interruptedReplies: counts.interruptedReplies,
    strippedToolCalls: counts.strippedToolCalls,
    orphanResults: build.counts.orphanResults,
    excludedFromContext: counts.excludedFromContext,
    emptySummaries: counts.emptySummaries,
    compactionAnchorsMissing: build.counts.compactionAnchorsMissing,
    compactionTailMismatch: build.counts.compactionTailMismatch,
    danglingCalls: build.counts.danglingCalls,
    droppedBlocks: counts.droppedBlocks,
    replayStateOmitted: counts.replayStateOmitted,
    turnsWithoutPrompt: build.counts.turnsWithoutPrompt,
    crashedRuns: build.counts.crashedRuns,
    strayStops: build.counts.strayStops,
  };
  report.result = resultReport(build, ir.grants?.grants.length ?? 0, ir.legacyPermissions !== null);
  report.lossy = lossy;
  const violation = verified(build.events);
  if (violation) return failed(report, 'verify', 'seed_invariant_violated', violation);
  const metadata = document.header.metadata ?? {};
  const convertedInMemory = source.generation.startsWith('pi-');
  return {
    ok: true,
    seed: build.events,
    images: build.images,
    cwd: document.header.cwd,
    grants: ir.grants,
    legacyPermissions: ir.legacyPermissions,
    origin: {
      kind: 'pi-session',
      converterVersion: SEED_CONVERTER_VERSION,
      sourceSha256: sha256Full,
      sourceBytes: source.bytes ?? 0,
      sourceSessionId:
        convertedInMemory && typeof metadata.sourceSessionId === 'string'
          ? metadata.sourceSessionId
          : document.header.id,
      sourceCreatedAt: document.header.createdAt,
      sourceFormat: source.generation,
      ...(!convertedInMemory && typeof metadata.importedFrom === 'string'
        ? { importedFrom: metadata.importedFrom }
        : {}),
      ...(!convertedInMemory && typeof metadata.sourceSha256 === 'string'
        ? { importedSourceSha256: metadata.sourceSha256 }
        : {}),
    },
    report,
  };
}

/**
 * The bytes of one pi session file → seed: 1.0.x's read-only decode chain
 * (`SessionReplayReader`: fatal UTF-8, first row, legacy formats converted in
 * memory, v4 decode) with unfinished SDK operations tolerated, then the
 * active branch converted. Legacy conversion takes its made-up ids from the
 * source's sha256, so the same bytes always give the same seed.
 */
export function convertPiSessionBytes(
  bytes: Uint8Array,
  input: PiSourceInput
): SeedConversionResult {
  const sha256Full = createHash('sha256').update(bytes).digest('hex');
  const source: SeedSourceReport = {
    kind: 'pi-session',
    generation: 'unknown',
    bytes: bytes.length,
    sha256: sha256Full.slice(0, 16),
    entries: {},
  };
  const report: SeedReport = { converterVersion: SEED_CONVERTER_VERSION, source };
  if (bytes.length > SESSION_MAX_BYTES)
    return failed(report, 'read', 'source_too_large', `source exceeds ${SESSION_MAX_BYTES} bytes`);
  let text: string;
  try {
    // The readers' rule: fatal UTF-8, and a tail cut mid-character reads as a torn row.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: bytes[bytes.length - 1] !== 10,
    });
  } catch (error) {
    return failed(report, 'read', 'source_invalid_utf8', errorOf(error).message);
  }
  let document: SessionDocument;
  try {
    const first = firstRow(text, input.sourceFile);
    let native = text;
    if (first.kind === 'header' && first.version === 4) source.generation = 'native-v4';
    else if (first.type === 'session') {
      source.generation = first.schema === 1 ? 'pi-desktop-1' : `pi-v${String(first.version ?? 1)}`;
      let next = 0;
      native = convertLegacySession(
        text,
        typeof first.cwd === 'string' && first.cwd ? first.cwd : input.cwd,
        input.sourceFile,
        true,
        { newId: () => `${source.sha256}-${++next}`, now: () => 0 }
      );
    }
    document = decodeSession(native, { tolerateUnfinished: true });
  } catch (error) {
    const { code, message } = errorOf(error);
    return failed(
      report,
      'decode',
      code === 'seed_build_failed' ? 'session_invalid' : code,
      message
    );
  }
  if (source.generation === 'native-v4') {
    if (document.entries.some((entry) => typeof entry.seq !== 'number'))
      source.generation = 'native-v4+cli';
    else if (
      document.entries.some(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'aiclient.legacy-import.provenance'
      )
    )
      source.generation = 'native-v4-import';
    const copiedFrom = document.header.metadata?.sourceFormat;
    if (typeof copiedFrom === 'string') source.copiedFrom = copiedFrom;
  }
  const parents = new Set(document.entries.map((entry) => entry.parentId));
  source.entries = countBy(document.entries.map(entryKind));
  source.leaves = document.entries.filter((entry) => !parents.has(entry.id)).length;
  source.skippedRows = document.skipped?.length ?? 0;
  source.tornTail = tornTail(text);
  source.unfinishedOperations = document.unfinished?.length ?? 0;
  return convertPiSessionDocument(document, { ...source, sha256Full });
}

/**
 * A Claude Code / Codex conversation (Main's `ImportedConversation`) → seed
 * (decision 056), with 1.0.x's two import checks: a reply survived, and no
 * display row is model-visible.
 */
export function convertImportedConversation(
  conversation: ImportedConversation
): SeedConversionResult {
  const source: SeedSourceReport = {
    kind: 'imported-conversation',
    generation: conversation.sourceKind,
    entries: {},
  };
  const report: SeedReport = { converterVersion: SEED_CONVERTER_VERSION, source };
  let ir: ReturnType<typeof importedConversationIr>;
  let build: SeedBuild;
  try {
    ir = importedConversationIr(conversation);
    source.entries = ir.entries;
    if (ir.replies === 0)
      return failed(
        report,
        'build',
        'WORKER_IMPORT_VALIDATION_FAILED',
        'Imported session did not retain an assistant response'
      );
    build = buildSeed(ir.items, { inferInterruptions: false });
  } catch (error) {
    const { code, message } = errorOf(error);
    return failed(report, 'build', code, message);
  }
  report.result = resultReport(build, 0, false);
  report.lossy = {
    offBranchEntries: 0,
    offBranchLabels: 0,
    labels: 0,
    bookkeeping: 0,
    sessionName: false,
    errorReplyBodies: 0,
    interruptedReplies: 0,
    strippedToolCalls: 0,
    orphanResults: build.counts.orphanResults,
    excludedFromContext: 0,
    emptySummaries: 0,
    compactionAnchorsMissing: 0,
    compactionTailMismatch: 0,
    danglingCalls: build.counts.danglingCalls,
    droppedBlocks: 0,
    replayStateOmitted: 0,
    turnsWithoutPrompt: build.counts.turnsWithoutPrompt,
    crashedRuns: 0,
    strayStops: 0,
  };
  const display = new Set(ir.displayIds);
  const visible = seedSurface(build.events).map((seq) => {
    const data = build.events[seq]?.data as { id?: unknown; message?: { id?: unknown } };
    return String(data?.message?.id ?? data?.id);
  });
  if (visible.some((id) => display.has(id)))
    return failed(
      report,
      'verify',
      'WORKER_IMPORT_CONTEXT_LEAK',
      'Display-only legacy entries leaked into model context'
    );
  const violation = verified(build.events);
  if (violation) return failed(report, 'verify', 'seed_invariant_violated', violation);
  return {
    ok: true,
    seed: build.events,
    images: build.images,
    cwd: conversation.workspacePath,
    grants: null,
    legacyPermissions: null,
    origin: {
      kind: 'imported-conversation',
      converterVersion: SEED_CONVERTER_VERSION,
      sourceKind: conversation.sourceKind,
      sourceSessionId: conversation.sourceSessionId,
      stableSourceIdentity: conversation.stableSourceIdentity,
      contentHash: conversation.sourceFingerprint.contentHash,
      importerVersion: conversation.importerVersion,
      schemaVersion: conversation.schemaVersion,
      idPrefix: ir.idPrefix,
    },
    report,
  };
}
