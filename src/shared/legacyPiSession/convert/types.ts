// New in dsh-rebase P1-9b

/**
 * Vocabulary of the pi → DSH seed converter: the seed events it emits, the
 * intermediate representation between a source and its seed, and the report.
 *
 * A seed is the replay history `agents.create({seed})` takes (plan P1-9 shard
 * 03 §1): lossless JSON, seq contiguous from 0, shaped the way
 * `dsh-agent-loop` writes a log. Declared here, not imported: this library
 * runs in the root Vitest and bundled into the DSH host, and may load no DSH
 * package (the static guard in `__tests__` holds it to that).
 */

import type { PersistedGrants } from '../../permissions/grants.ts';
import type { RuntimePermissionSettings } from '../../types/runtimePermission.ts';

/**
 * Bumped whenever the same source bytes would convert to a different seed.
 * A seed is a pure function of (source bytes, this number) — decision 054.
 * 2 (P1-9c, decision 121): compactions are written in DSH's transaction.
 */
export const SEED_CONVERTER_VERSION = 2;

/** Ignorable event types a seed may carry (decision 053); never appended at run time. */
export const SEED_EVENT_TYPE = {
  legacyProvenance: 'aiclient/legacy-provenance',
  legacyDisplay: 'aiclient/legacy-display',
  piEntry: 'aiclient/pi-entry',
  piLabel: 'aiclient/pi-label',
  piSubagent: 'aiclient/pi-subagent',
} as const;

/** `MessageSource.kind` of the user-role messages a seed carries. */
export const SEED_SOURCE_KIND = {
  user: 'user',
  /** A message the 1.0.x runtime wrote for itself (`aiclientInternal`): model-visible, never a bubble. */
  piInternal: 'aiclient-pi-internal',
  /** A pi extension message (`role: 'custom'`), rendered the way pi's `convertToLlm` did. */
  piCustom: 'aiclient-pi-custom',
  /** A TUI `!command` (`role: 'bashExecution'`), rendered by `bashExecutionToText`. */
  piBash: 'aiclient-pi-bash',
  /** A pi branch summary, with pi's prefix and suffix. Shown as "Context summary" in 1.0.x. */
  piBranchSummary: 'aiclient-pi-branch-summary',
  /** A pi compaction summary message outside a compaction entry (not written by 1.0.x). */
  piCompactionSummary: 'aiclient-pi-compaction-summary',
  /** A copy of a message a pi compaction retained, re-added after the checkpoint. */
  piRetained: 'aiclient-pi-retained',
  /** DSH's compaction replacement node (`dsh-compaction`). */
  checkpoint: 'compact-checkpoint',
} as const;

/** `MessageSource.kind` of a system prompt node (`dsh-llm`). */
export const SYSTEM_PROMPT_SOURCE_KIND = 'system-prompt';

/** Lossless JSON, the only data a DSH session log stores. */
export type SeedJson = null | boolean | number | string | SeedJson[] | { [key: string]: SeedJson };

export type SeedSurfaceOp = 'append' | { op: 'replace'; startSeq: number; endSeq: number };

/**
 * One seed event: DSH's `SessionEvent` envelope. Assignable to
 * `dshHistory`'s `DshLogEvent`, so a seed projects like a stored log.
 */
export interface DshSeedEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: SeedSurfaceOp;
  sourceEventSeqs?: number[];
  ignorable?: true;
}

/**
 * An image the host still has to admit through `ctx.attachments`.
 *
 * A pure converter cannot make an `ImageAttachmentRef` (it needs the stored
 * object's id and dimensions), so the seed carries this in the block's
 * `attachment` slot and `bindSeedImages` swaps it for the admitted reference.
 * `mediaType` and `name` ride along so a pending seed projects the same
 * attachment chips a bound one does.
 */
export interface PendingImageRef {
  pendingImage: string;
  mediaType: string;
  name?: string;
}

export type SeedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; attachment: PendingImageRef };

/** One distinct (bytes, name) image the seed references, in first-use order. */
export interface SeedImage {
  key: string;
  mediaType: string;
  /** Base64, exactly as the source stored it. */
  data: string;
  name?: string;
}

/** DSH `TokenUsage`, filled the way `dsh-llm-pi-ai`'s `mapUsage` fills it. */
export interface SeedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ---- intermediate representation -------------------------------------------------

/** An image before admission: what the source block held. */
export interface IrImage {
  type: 'image';
  mediaType: string;
  data?: string;
  name?: string;
}

export type IrBlock = Exclude<SeedContentBlock, { type: 'image' }> | IrImage;

/** A user-role message: a prompt, an internal message, or pi context rendered as user text. */
export interface IrInput {
  kind: 'input';
  id: string;
  time: number;
  /** A human prompt or a delegation report starts a run, and so a turn. */
  opensTurn: boolean;
  source: { kind: string } & { [key: string]: SeedJson };
  content: IrBlock[];
}

export interface IrToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** How the source reply ended (pi-ai `stopReason`, widened). */
export type IrAssistantEnd =
  | 'stop'
  | 'length'
  | 'toolUse'
  | 'error'
  | 'aborted'
  | 'deferred'
  | 'other';

/**
 * One model reply. `message` enters model history; `interrupted` is a Stop
 * cut short with visible text (decision 055: model-visible, undispatched
 * calls dropped); `attempt` never enters model history.
 */
export interface IrAssistant {
  kind: 'assistant';
  id: string;
  time: number;
  outcome: 'message' | 'interrupted' | 'attempt';
  ends: IrAssistantEnd;
  content: IrBlock[];
  provider: string;
  model: string;
  replayState?: SeedJson;
  usage?: SeedTokenUsage;
  /** Calls the loop would dispatch; empty for `interrupted` and `attempt`. */
  calls: IrToolCall[];
  errorMessage?: string;
}

export interface IrResult {
  kind: 'result';
  id: string;
  time: number;
  callId: string;
  content: IrBlock[];
  isError: boolean;
  error?: { name: string; code: string };
  meta?: SeedJson;
  /** What stands in for the result when no open call answers to it. */
  orphan: IrIgnorable;
}

/**
 * A pi compaction. Where the kept tail starts is decided against the live
 * surface by the seed builder, from these facts.
 */
export interface IrCheckpoint {
  kind: 'checkpoint';
  id: string;
  time: number;
  summary: string;
  /** Messages pi kept after its summary. */
  retainedCount: number;
  /** Entry ids, in branch order, one of which starts the kept tail on the surface. */
  anchors: string[];
  /** The retained messages themselves, when every one is a user message. */
  retainedUserCopies?: IrBlock[][];
}

export interface IrIgnorable {
  kind: 'ignorable';
  time: number;
  type: string;
  data: SeedJson;
}

/** `aiclient.runStop`: the user ended the run (Stop, or Ctrl+Enter at a boundary). */
export interface IrStop {
  kind: 'stop';
  time: number;
  cause: 'user_stop' | 'interjected';
}

/** A run the file started (an SDK `operation_started`) and never finished. */
export interface IrCrash {
  kind: 'crash';
  time: number;
}

export type IrItem =
  | IrInput
  | IrAssistant
  | IrResult
  | IrCheckpoint
  | IrIgnorable
  | IrStop
  | IrCrash;

// ---- report ------------------------------------------------------------------

/** Where a conversion failed: reading the bytes, decoding pi, building the seed, or checking it. */
export type SeedFailureStage = 'read' | 'decode' | 'build' | 'verify';

export interface SeedFailure {
  stage: SeedFailureStage;
  code: string;
}

/** Counts only: no text, title, path or file name ever enters a report (plan P1-9 shard 02 §5). */
export interface SeedSourceReport {
  kind: 'pi-session' | 'imported-conversation';
  /** pi: `native-v4`, `native-v4+cli`, `native-v4-import`, `pi-v1`… ; import: the source kind. */
  generation: string;
  /** For a 1.0.x `.native-v4.jsonl` copy: the format of the file it was copied from. */
  copiedFrom?: string;
  bytes?: number;
  /** First 16 hex digits of the source bytes' sha256. */
  sha256?: string;
  /** Source entries by kind (`message:user`, `custom:aiclient.runStop`, `import:display`…). */
  entries: Record<string, number>;
  /** pi: entries on the active branch, and leaves of the whole tree. */
  branchEntries?: number;
  leaves?: number;
  /** Rows the decoder dropped (session-02) and whether the last row was torn. */
  skippedRows?: number;
  tornTail?: boolean;
  /** SDK operations the file started and never finished. */
  unfinishedOperations?: number;
}

export interface SeedResultReport {
  events: Record<string, number>;
  turns: number;
  steps: number;
  turnEnds: Record<string, number>;
  /** Distinct images waiting for admission, and image blocks referencing them. */
  images: number;
  imageBlocks: number;
  ignorable: Record<string, number>;
  checkpoints: {
    keptOriginals: number;
    retainedCopies: number;
    summaryOnly: number;
    appended: number;
  };
  /** Grants the sidecar will hold (0: no sidecar is written). */
  grants: number;
  legacyPermissions: boolean;
}

/** What 1.0.x had that the seed does not, or has differently. */
export interface SeedLossReport {
  /** Entries off the active branch (decision 052), and labels on them. */
  offBranchEntries: number;
  offBranchLabels: number;
  /** Labels carried as `aiclient/pi-label` (kept, not shown yet). */
  labels: number;
  /** `model_change`, permission records, CLI bookkeeping and the like. */
  bookkeeping: number;
  sessionName: boolean;
  /** Error replies whose partial text 1.0.x showed and the seed drops (attempt). */
  errorReplyBodies: number;
  /** Stopped replies with text that become model-visible `interrupted` messages (decision 055). */
  interruptedReplies: number;
  /** Undispatched tool calls removed from stopped or failed replies. */
  strippedToolCalls: number;
  orphanResults: number;
  excludedFromContext: number;
  emptySummaries: number;
  /** Compactions whose kept tail could not be placed and keep the summary alone. */
  compactionAnchorsMissing: number;
  /** Compactions whose kept tail on the surface is wider or narrower than pi's retained tail. */
  compactionTailMismatch: number;
  /** Calls left without a result, closed as `TOOL_OUTCOME_UNKNOWN`. */
  danglingCalls: number;
  /** Assistant image blocks and blocks of unknown type (not carried). */
  droppedBlocks: number;
  /** Assistant messages kept without `replayState` (blocks could not be aligned, or no pi-ai metadata). */
  replayStateOmitted: number;
  /** Turns that begin with a reply rather than a prompt. */
  turnsWithoutPrompt: number;
  /** Runs the file started and never finished, closed as an empty `interrupted` turn. */
  crashedRuns: number;
  /** `aiclient.runStop` records with no run to stop. */
  strayStops: number;
}

export interface SeedReport {
  converterVersion: number;
  source: SeedSourceReport;
  result?: SeedResultReport;
  lossy?: SeedLossReport;
  failure?: SeedFailure;
}

/** What the host writes into the stub's `origin` (decision 006) besides the seed itself. */
export type SeedOrigin =
  | {
      kind: 'pi-session';
      converterVersion: number;
      sourceSha256: string;
      sourceBytes: number;
      /** The pi header id; for a legacy file, the id its own header carried. */
      sourceSessionId: string;
      /** DSH stamps its own header with the migration time; the source's is kept here. */
      sourceCreatedAt: number;
      sourceFormat: string;
      /** A 1.0.x copy: the legacy file it was made from, and that file's sha256. */
      importedFrom?: string;
      importedSourceSha256?: string;
    }
  | {
      kind: 'imported-conversation';
      converterVersion: number;
      sourceKind: string;
      sourceSessionId: string;
      stableSourceIdentity: string;
      contentHash: string;
      importerVersion: string;
      schemaVersion: number;
      /** Prefix of every message id minted for the conversation (`imp-<hash>`). */
      idPrefix: string;
    };

/** A seed ready for `agents.create`, once its images are bound. */
export interface SeedConversion {
  ok: true;
  seed: DshSeedEvent[];
  images: SeedImage[];
  /** `agents.create`'s `meta.cwd`; DSH never lets it change. */
  cwd: string;
  /** Sidecar content (decision 043); `null` writes no sidecar. */
  grants: PersistedGrants | null;
  /** The last mode / gear the file recorded, for a resume that names none. */
  legacyPermissions: RuntimePermissionSettings | null;
  origin: SeedOrigin;
  report: SeedReport;
}

export interface SeedConversionFailure {
  ok: false;
  failure: SeedFailure;
  /** For the host's own log. May name a path, so it never enters the report. */
  message: string;
  report: SeedReport;
}

export type SeedConversionResult = SeedConversion | SeedConversionFailure;
