/**
 * Route-B prototype: one chat on the official Claude Agent SDK, behind the
 * DSH bridge's worker RPC server (`BridgeSessionRuntime`).
 *
 * One long-lived `query()` per chat in streaming-input mode: sends and Ctrl+Enter
 * interjections are pushed into its input queue, Stop is `interrupt()`, and
 * approvals park in `canUseTool`. The SDK's messages are mapped onto the same
 * runtime events the DSH bridge emits (recorded in
 * `src/shared/__tests__/fixtures/dsh/stream.*.json`), so the renderer needs no
 * change: one assistant message per model step, `permissionId` equal to the
 * tool call id, a tool's result filed under the step that called it, and every
 * turn closed by a terminal event followed by `session.status idle`.
 *
 * Deliberately not implemented (the prototype doc §1 lists them; where that doc
 * lives: docs/plantree/plans/claude-sdk-engine/README.md §0):
 * rewind / fork / tree, background job windows, goals, withdrawing a
 * Ctrl+Enter message, `/compact` instructions, subagent lanes.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  type CanUseTool,
  getSessionMessages,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { BridgeSessionError } from '../dsh-host/bridge/bridgeErrors.ts';
import type {
  BridgeSessionRuntime,
  BridgeSessionRuntimeOptions,
} from '../dsh-host/bridge/bridgeRpcServer.ts';
import {
  CLAUDE_SDK_AUTO_COMPACT_WINDOW_MAX,
  CLAUDE_SDK_AUTO_COMPACT_WINDOW_MIN,
  PERMISSION_MODE_REFUSED,
  permissionModeRefusalReason,
} from '../shared/claudeSdkEngine.ts';
import {
  CONTEXT_WINDOW_NOTICE_KIND,
  contextWindowNotice,
} from '../shared/contextWindowMismatch.ts';
import { DSH_NOTICE_CUSTOM_TYPE_PREFIX } from '../shared/dshNotices.ts';
import { buildPiInterimUsagePayload, buildPiUsagePayload } from '../shared/piUsage.ts';
import {
  decodePlanReviewResponse,
  PLAN_REVIEW_QUESTION_ID,
  REVIEW_DISMISSED_TEXT,
  SDK_PLAN_REVIEW_CHOICES,
} from '../shared/planReview.ts';
import { resolveSettingSources } from '../shared/settingSources.ts';
import type { SessionAttachment, SessionEffortLevel } from '../shared/types/agentHost.ts';
import type {
  PermissionDecisionId,
  PermissionDetail,
  PermissionRequestAction,
  PermissionRequestKind,
  QuestionItem,
  RuntimeEventDraft,
} from '../shared/types/runtimeEvents.ts';
import {
  migratePermissionTier,
  type PermissionGear,
  type RuntimePermissionSettings,
} from '../shared/types/runtimePermission.ts';
import type { HistoryBlock, HistoryMessage, TurnOrigin } from '../shared/types/sessionHistory.ts';
import type { SessionPermissionTier } from '../shared/types/sessionPermissionTier.ts';
import {
  subagentHistoryOf,
  WORKER_JOB_READ_DEFAULT_BYTES,
  WORKER_SIDE_QUESTION_CANCELLED,
  WORKER_SIDE_QUESTION_UNAVAILABLE,
  type WorkerAcceptForkResult,
  type WorkerBootstrapResult,
  type WorkerCommandResult,
  type WorkerCommandsResult,
  type WorkerCompactCancelResult,
  type WorkerCompactResult,
  type WorkerDiscardForkResult,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerInterjectPayload,
  type WorkerInterjectResult,
  type WorkerInterjectWithdrawResult,
  type WorkerJobKillPayload,
  type WorkerJobKillResult,
  type WorkerJobReadPayload,
  type WorkerJobReadResult,
  type WorkerPanelsResult,
  type WorkerRewindResult,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerSideQuestionPayload,
  type WorkerSideQuestionResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerSubagentHistoryPayload,
  type WorkerSubagentHistoryResult,
  type WorkerSubagentInterruptResult,
  type WorkerToolBackgroundPayload,
  type WorkerToolBackgroundResult,
  type WorkerTreeResult,
} from '../shared/types/workerRpc.ts';
import { mapSdkFailure, redactSecrets, type SdkFailureSignals } from './failureMapping.ts';
import {
  descendantsOf,
  killProcess,
  msysProcessTable,
  msysToolProcesses,
  type ProcessRow,
  reap,
  sampleProcesses,
} from './processTree.ts';
import { type ClaudeSdkSessionStub, createStub, readStub, writeStub } from './sessionStub.ts';
import {
  type CliSlashCommand,
  cliSlashCommands,
  commandRowLine,
  localCommandOutput,
  SDK_TERMINAL_COMMANDS_DEFAULT,
  SDK_WINDOW_OWNED_COMMANDS,
  sdkSlashCommandRows,
} from './slashCommands.ts';
import { projectSubagentTranscript } from './subagentTranscript.ts';
import { type BoardChange, TaskBoard } from './taskBoard.ts';
import { ToolProcessTracker } from './toolProcessTracker.ts';

export interface SdkHostConfig {
  configDir: string;
  settingSources: Array<'project' | 'local' | 'user'>;
  /** A `.js` Claude Code build to run on Node instead of the bundled native binary. */
  cliPath?: string;
  gitBashPath?: string;
  cliEnv: Record<string, string>;
  /**
   * The flag tier's `env` (`buildPinnedSettingsEnv`): what a repository's
   * settings may not change. Goes onto the CLI's command line, so never a secret.
   */
  settingsEnv: Record<string, string>;
  /** Values blanked out of any text the host quotes to the UI (the gateway key). */
  secrets?: readonly string[];
  /**
   * The catalog's context windows by CLI model id, where they are below what
   * the CLI assumes (`claudeSdkModelWindows`). Handed to the CLI as per-model
   * auto-compact windows and capping the window the UI is told.
   */
  modelWindows?: Readonly<Record<string, number>>;
  /**
   * Probes only: a stand-in home directory whose `.claude` the CLI's walk up from
   * the cwd must not read either, besides `os.homedir()`'s (S-3 P-5, P-11).
   */
  homeDir?: string;
}

/** A flag-tier change. Never `env`: the CLI replaces the key whole, which would drop the pins. */
type FlagSettingsPatch = Omit<Parameters<Query['applyFlagSettings']>[0], 'env'>;

/** What the turn's messages said about a failure before its result (decision 7's inputs). */
interface FailureSignals {
  assistantError?: string;
  retry?: { error?: string; error_status?: number | null; no_response?: unknown };
}

/**
 * The PiLab note appended to the `claude_code` preset. Our own words, kept
 * short and static so it never disturbs the cached prefix.
 */
export const PILAB_PROMPT_APPEND = [
  '# PiLab',
  'You are running inside PiLab, a desktop app. The user reads this conversation in a chat window:',
  'tool calls appear as rows, approvals and your questions appear as cards, and markdown is rendered.',
  'Reply in the language the user writes in.',
].join('\n');

/**
 * Preset tools PiLab keeps off (README ruling 24, S-6 feedback 1): `RemoteTrigger` needs a
 * claude.ai account (PiLab authenticates with an API key); `ListAgents` and `SendMessage`
 * message other sessions with nothing in PiLab to show it (issue #22); `Workflow` waits for
 * the background-jobs window to carry it. The worktree and schedule tools are on since S-6,
 * and so is `ReportFindings`: the window draws its report as the review card. The CLI marks
 * it read-only with no permission check of its own, so it never reaches `canUseTool`.
 */
export const HOST_ONLY_TOOLS = ['RemoteTrigger', 'ListAgents', 'SendMessage', 'Workflow'];

/**
 * User rows of the CLI transcript that are bookkeeping, not something typed. A command's
 * own row (`<command-name>`, `<command-message>`) and a local command's output are read
 * before this (decision 194, `slashCommands.ts`).
 */
const CLI_MARKER_TEXT = /^(\[Request interrupted by user|<local-command-caveat>)/;
/** The model of a message the CLI wrote itself (a local command's output, decision 194). */
const SYNTHETIC_MODEL = '<synthetic>';
const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
/** User 2026-10-23: what a `/compact` without instructions asks the summary to keep. */
export const DEFAULT_COMPACT_INSTRUCTIONS =
  '只保留：当前目标；已完成和未完成事项；已修改文件；关键设计决定及原因；失败方案及其证据；测试结果；未解决风险；下一步验证计划。删除闲聊、重复输出、过时计划和已经失效的尝试。';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_CHANGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** How long Stop waits for the CLI to close the turn itself before closing it here. */
const STOP_SETTLE_MS = 5_000;
/** Decision 201: `system/init`'s capability for an `interrupt` that is a Send now, not a Stop. */
const SEND_NOW_CAPABILITY = 'interrupt_send_now_v1';
/**
 * How long Stop (and dispose) waits for a process sample already in flight before it
 * interrupts (README §11.2 #52): the sample is taken in the background from the moment a
 * shell call starts (toolProcessTracker.ts), so this only closes the gap for a call that
 * started just before Stop. A sample is never started here; a slow one is left behind.
 */
const STOP_SAMPLE_WAIT_MS = 1_000;
/** How long a mode switch waits for the CLI's answer; under Main's 10 s RPC timeout. */
const MODE_SWITCH_TIMEOUT_MS = 8_000;
/**
 * How long the menu waits for a CLI it started to list its commands (decision 194): a
 * cold start took up to 3.8 s on the dev box (2.1.300); under Main's 10 s RPC timeout.
 */
const COMMANDS_TIMEOUT_MS = 8_000;

type Log = (...args: unknown[]) => void;

/** A runtime event without the two fields `emit` adds, kept per member so payloads stay checked. */
type EventBody = RuntimeEventDraft extends infer T
  ? T extends unknown
    ? Omit<T, 'sessionId' | 'requestId'>
    : never
  : never;

interface StepBlock {
  kind: 'text' | 'thinking' | 'tool';
  blockId: string;
  toolCallId?: string;
  name?: string;
  json?: string;
}

interface Step {
  messageId: string;
  apiMessageId: string;
  blocks: Map<number, StepBlock>;
  promptTokens: { input: number; cacheRead: number; cacheWrite: number };
  output: number;
}

interface Interjection {
  attemptId: string;
  text: string;
  attachments?: SessionAttachment[];
  /**
   * What the CLI's `command_lifecycle` frames last said of it (2.1.300): `queued` once it
   * is in the CLI's command queue, `started` once a CLI turn runs on it. Absent until the
   * first frame (an older CLI sends none).
   */
  cliState?: 'queued' | 'started';
  /**
   * Decision 201: "Send now" asked for it. The CLI's Send now names a message waiting
   * in its queue, so the request goes once `command_lifecycle` says `queued`; sent before,
   * it finds nothing waiting (measured on 2.1.300: `nothing_waiting`).
   */
  sendNow?: 'pending' | 'sent';
}

interface Turn {
  requestId: string;
  stopRequested: boolean;
  step: Step | null;
  /** toolCallId → the step message that called it. */
  toolMessage: Map<string, string>;
  /** toolCallId → why the call did not run (our card said no, or Stop took it). */
  toolOutcome: Map<string, 'refused' | 'stopped' | 'notStarted'>;
  /** toolCallId → what the row says of a call the CLI refused itself (S-2: Auto's check). */
  refusals: Map<string, string>;
  interjections: Map<string, Interjection>;
  /**
   * The CLI ended its turn while a Ctrl+Enter message of this one was still in its queue:
   * the product turn stays open for the CLI turn that runs it (S-6 feedback 13).
   */
  heldForInterjection?: boolean;
  /** toolCallId of every Bash/PowerShell call still running: while any is, its processes are sampled. */
  shellCalls: Set<string>;
  stopTimer?: ReturnType<typeof setTimeout>;
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

interface PendingQuestion {
  kind: 'question' | 'plan-review';
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

/** Async input of the long-lived query: pushed by send / interject, closed by dispose. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    this.items.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as SDKUserMessage;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

/** `provider/modelId` → the bare id the gateway serves. */
export function bareModelId(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/**
 * The catalog's windows as the CLI's flag-tier `modelSettings` (user 2026-10-18):
 * each model's auto-compact window, which the CLI clamps to the model's own
 * (2.1.300, measured: claude-opus-5-5 at 200,000 compacts at 167,000 instead of
 * 967,000). Nothing when there are none, so the settings stay as they were.
 *
 * Only windows below the CLI's ceiling are told. A larger value cannot widen a
 * model the CLI holds to 200k (that takes the `[1m]` model suffix), and leaving
 * 1M rows out keeps the CLI's own tuned default for them. A window under the
 * CLI's floor is raised to it: the nearest the CLI accepts.
 */
export function catalogModelSettings(windows: Readonly<Record<string, number>> | undefined): {
  modelSettings?: Record<string, { autoCompactWindow: number }>;
} {
  const entries = Object.entries(windows ?? {}).filter(
    ([, window]) => window < CLAUDE_SDK_AUTO_COMPACT_WINDOW_MAX
  );
  if (entries.length === 0) return {};
  return {
    modelSettings: Object.fromEntries(
      entries.map(([model, window]) => [
        model,
        { autoCompactWindow: Math.max(CLAUDE_SDK_AUTO_COMPACT_WINDOW_MIN, window) },
      ])
    ),
  };
}

/**
 * The window the CLI reports for `model`, held to the catalog's when that is
 * smaller: the CLI keeps reporting its own table's (1M) after it was told to
 * compact earlier, and the context meter should show the window that applies.
 */
export function cappedContextWindow(
  reported: number,
  windows: Readonly<Record<string, number>> | undefined,
  model: string
): number {
  const declared = windows && Object.hasOwn(windows, model) ? windows[model] : undefined;
  return declared !== undefined && declared > 0 && declared < reported ? declared : reported;
}

/**
 * PiLab's mode and gear → the CLI's permission mode, one to one (S-2 A-1):
 * Manual, Edit automatically, Plan, Auto, Bypass permissions. Plan mode is
 * `plan` whatever gear it is stored with.
 */
export function cliPermissionMode(settings: RuntimePermissionSettings): PermissionMode {
  if (settings.mode === 'plan') return 'plan';
  switch (settings.gear) {
    case 'bypass':
      return 'bypassPermissions';
    case 'accept-edits':
      return 'acceptEdits';
    case 'auto':
      return 'auto';
    default:
      return 'default';
  }
}

/**
 * The CLI's mode → the pair PiLab stores (the composer's plan preset for
 * `plan`). Null for a mode PiLab never sets (`dontAsk`) or does not know.
 */
export function permissionsForCliMode(mode: string): RuntimePermissionSettings | null {
  switch (mode) {
    case 'plan':
      return { mode: 'plan', gear: 'auto' };
    case 'default':
      return { mode: 'agent', gear: 'ask' };
    case 'acceptEdits':
      return { mode: 'agent', gear: 'accept-edits' };
    case 'auto':
      return { mode: 'agent', gear: 'auto' };
    case 'bypassPermissions':
      return { mode: 'agent', gear: 'bypass' };
    default:
      return null;
  }
}

/** A refused `setPermissionMode` as the worker reports it: our code, the reason as the message. */
function permissionModeRefused(error: unknown): BridgeSessionError {
  // 2.1.300 rejects with a plain Error carrying a stable `errorCode` (auto_mode_settings,
  // bypass_disabled, ...); its message never names the code (s2 topic §4.1).
  const fields = (error ?? {}) as { errorCode?: unknown; code?: unknown };
  const code = [fields.errorCode, fields.code].filter((item) => typeof item === 'string').join(' ');
  const text = `${code} ${error instanceof Error ? error.message : String(error)}`;
  return new BridgeSessionError(PERMISSION_MODE_REFUSED, permissionModeRefusalReason(text));
}

/**
 * S-2: the tool row's words for a call the CLI refused itself. Never its own
 * sentence, which names Claude Code; the reason it gives (a rule name such as
 * `[Irreversible Local Destruction]`, or `Classifier unavailable`) is kept.
 */
export function cliRefusalText(type: unknown, reason: unknown): string {
  // Safety-check reasons name the product too ("This writes to the Claude Code
  // shell-snapshots folder. Claude Code runs the scripts there…", 2.1.300).
  const why =
    typeof reason === 'string' && reason.trim()
      ? reason
          .trim()
          .replace(/\bthe Claude Code\b/gi, "the agent's")
          .replace(/(^|[.!?]\s+)Claude Code\b/g, '$1The agent')
          .replace(/\bClaude Code\b/gi, 'the agent')
          .replace(/[.!?\s]+$/, '')
      : '';
  if (type === 'classifier') {
    return /unavailable|could not evaluate|no (server )?verdict/i.test(why)
      ? "Auto mode's safety check was not available, so this call did not run."
      : `Auto mode's safety check blocked this call${why ? `: ${why}` : ''}.`;
  }
  return `The permission settings refused this call${why ? `: ${why}` : ''}.`;
}

/** A refusal the CLI wrote into the tool result without its event (the same rewording). */
function cliRefusalRewrite(text: string): string {
  if (/denied by the Claude Code auto mode classifier/i.test(text)) {
    const reason = /Reason: (.+?)\. /.exec(text)?.[1];
    return cliRefusalText('classifier', reason);
  }
  if (
    /auto mode cannot determine|Auto mode could not evaluate|Auto mode is unavailable/i.test(text)
  )
    return cliRefusalText('classifier', 'Classifier unavailable');
  return text;
}

/**
 * S-3 P-1: the setting sources a chat's CLI starts with: the configured ones,
 * project and local closed for an untrusted checkout (`resolveSettingSources`).
 */
export function launchSettingSources(
  configured: SdkHostConfig['settingSources'],
  projectTrusted: boolean | undefined
): SdkHostConfig['settingSources'] {
  const gate = resolveSettingSources({
    settingSources: configured,
    projectTrusted: projectTrusted === true,
  });
  return (['user', 'project', 'local'] as const).filter((source) => gate[source]);
}

/** Where a path leads past links, junctions and substituted drives; null if it does not exist. */
export type ResolvePath = (target: string) => string | null;

const resolveRealPath: ResolvePath = (target) => {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
};

/** One spelling of a directory, for comparisons: Windows paths fold case and slashes. */
function foldDir(dir: string): string {
  const trimmed = dir.length > 1 ? dir.replace(/(?<!^[A-Za-z]:)[\\/]+$/, '') : dir;
  return process.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

/**
 * A directory as a picomatch literal: forward slashes, and syntax characters as
 * one-character classes (a backslash escape would read as a separator on Windows).
 */
function globLiteral(dir: string): string {
  const slashed = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.replace(/[()[\]{}*?+@]/g, '[$&]');
}

/** The home directories as spelled and as they resolve, folded. */
function homeTargets(homes: readonly string[], resolve: ResolvePath): Set<string> {
  const targets = new Set<string>();
  for (const home of homes) {
    targets.add(foldDir(home));
    const real = resolve(home);
    if (real) targets.add(foldDir(real));
  }
  return targets;
}

/** The cwd and each of its ancestors, as spelled. */
function selfAndAncestors(cwd: string): string[] {
  const dirs = [cwd];
  for (let dir = cwd; path.dirname(dir) !== dir; ) {
    dir = path.dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

const isHomeDir = (dir: string, targets: Set<string>, resolve: ResolvePath) => {
  if (targets.has(foldDir(dir))) return true;
  const real = resolve(dir);
  return real !== null && targets.has(foldDir(real));
};

/**
 * S-3 P-5, P-7: the `claudeMdExcludes` globs for the user's `~/.claude`. The CLI
 * walks up from the cwd as spelled and matches case-sensitively (measured on
 * Windows: the drive letter's case matters, either slash works), so every
 * ancestor of the cwd that is a home directory (in another case, or reached
 * through a link, a junction or a substituted drive) adds a glob in the cwd's
 * own spelling; each home directory as given is always one.
 */
export function userClaudeDirExcludes(
  cwd: string,
  homes: readonly string[],
  resolve: ResolvePath = resolveRealPath
): string[] {
  const targets = homeTargets(homes, resolve);
  const globs = new Set(homes.map((home) => `${globLiteral(home)}/.claude/**`));
  for (const dir of selfAndAncestors(cwd)) {
    if (isHomeDir(dir, targets, resolve)) globs.add(`${globLiteral(dir)}/.claude/**`);
  }
  return [...globs];
}

/**
 * S-3 P-10: a chat bound to a home directory itself would read the user's own
 * `~/.claude/settings*.json` (hooks, allow rules, env) as the project's, since
 * the CLI's user tier is the app-private config dir (plan §3: PiLab reads no
 * user-level layer), so it is opened as a scratch chat is.
 */
export function isUserHomeDir(
  cwd: string,
  homes: readonly string[],
  resolve: ResolvePath = resolveRealPath
): boolean {
  return isHomeDir(cwd, homeTargets(homes, resolve), resolve);
}

function effortOptions(
  effort: SessionEffortLevel | undefined
): Pick<Options, 'effort' | 'thinking'> {
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  const level = effort === 'minimal' ? 'low' : effort;
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(level ? { effort: level } : {}),
  };
}

function userContent(
  text: string,
  attachments?: SessionAttachment[]
): SDKUserMessage['message']['content'] {
  if (!attachments?.length) return text;
  const blocks: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
      });
    } else {
      blocks.push({
        type: 'text',
        text: `<attachment name="${attachment.name ?? 'pasted.txt'}">\n${attachment.data}\n</attachment>`,
      });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks as unknown as SDKUserMessage['message']['content'];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A local command's output as a history reply (decision 194). */
function localReply(uuid: string, text: string): HistoryMessage {
  return {
    id: `h:${uuid}`,
    entryId: uuid,
    role: 'assistant',
    blocks: [{ type: 'text', id: `${uuid}-text`, text }],
  };
}

/** The text blocks of an assistant frame, joined. */
function assistantText(message: { content?: unknown }): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((block) => {
      const b = record(block);
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** What a subagent said, in order: the text blocks of its transcript's assistant messages. */
export function subagentText(transcriptFile: string): string {
  let raw = '';
  try {
    raw = readFileSync(transcriptFile, 'utf8');
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content as Array<{ type?: unknown; text?: unknown }>) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join('\n\n');
}

/** `worker.job.read`'s window over bytes held in memory (from/next/omitted as for a file). */
function windowOf(
  bytes: Buffer,
  from: number | undefined,
  maxBytes: number,
  source: string
): WorkerJobReadResult {
  const size = bytes.length;
  const asked = Math.min(Math.max(0, from ?? Math.max(0, size - maxBytes)), size);
  const start = Math.max(asked, size - maxBytes);
  return {
    text: bytes.subarray(start).toString('utf8'),
    from: start,
    next: size,
    omittedBytes: from === undefined ? start : start - asked,
    lossy: false,
    spillPaths: [source],
  };
}

export class ClaudeSdkSessionRuntime implements BridgeSessionRuntime {
  private readonly options: BridgeSessionRuntimeOptions;
  private readonly config: SdkHostConfig;
  private readonly log: Log;
  /** What the running shell call started, sampled in the background for Stop (#52). */
  private readonly tracker = new ToolProcessTracker(() => this.collectToolProcesses());
  private stubFile = '';
  private stub: ClaudeSdkSessionStub | null = null;
  private bootstrapResult: WorkerBootstrapResult | null = null;
  private query: Query | null = null;
  private input: InputQueue | null = null;
  private pumpDone: Promise<void> = Promise.resolve();
  private modelRef: string | undefined;
  private effort: SessionEffortLevel | undefined;
  private permissions: RuntimePermissionSettings;
  /** The mode the CLI last reported (`system/init`, `system/status`); null while none runs. */
  private cliMode: string | null = null;
  /** Mode switches sent and not answered yet: the CLI's reports in between are not drift. */
  private modeRequests = 0;
  /** S-5 H-4: the running CLI has initialized and answers control requests. */
  private cliReady = false;
  /** S-5 H-4: a mode picked before the CLI was ready, sent once it is. */
  private deferredMode: RuntimePermissionSettings | null = null;
  private turn: Turn | null = null;
  private turnCount = 0;
  private userMessageCount = 0;
  /**
   * Decision 204: this host's mark in every id it mints. A chat released while idle and
   * reopened gets a new host whose counters start at 1 again, while the window keeps the
   * rows it drew; without the mark the first reply reused an old row's id and was drawn
   * into that row, far up the timeline.
   */
  private readonly idTag = randomUUID().slice(0, 6);
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** Decision 194: the CLI's command list (`initializationResult`, then `commands_changed`). */
  private cliCommands: CliSlashCommand[] | null = null;
  /** The rows the CLI binds to a terminal; 2.1.300's set until its `system/init` says. */
  private terminalCommands: string[] = [...SDK_TERMINAL_COMMANDS_DEFAULT];
  /** Decision 201: the CLI's `system/init` advertised `interrupt_send_now_v1`. */
  private cliSendNow = false;
  /** The last task notification was a subagent's (an engine turn it wakes is the subagent's). */
  private lastTaskWasAgent = false;
  /**
   * S-6 (ruling 24): the CLI began a command of its own while no turn was open (a
   * ScheduleWakeup or cron prompt coming due; task notifications carry no command
   * uuid): the engine turn it opens is a scheduled one.
   */
  private scheduledWake = false;
  /** Task ids `task_started` named as subagents; `task_notification` carries no task type. */
  private readonly agentTaskIds = new Set<string>();
  /** Tool inputs as streamed, for a card raised before the stream finished (ExitPlanMode's plan). */
  private readonly streamedInputs = new Map<string, unknown>();
  private readonly streamedWaiters = new Map<string, (input: unknown) => void>();
  /** Live background tasks of this CLI process (decision 8), reported on every `session.status`. */
  private backgroundTasks = 0;
  /** S-6 feedback 4: the CLI's tasks as the jobs window, the subagents window and lanes draw them. */
  private readonly board = new TaskBoard();
  /**
   * S-6 feedback 4 (Windows): a background command's Git Bash process group, noted when
   * it starts. A stopped task's MSYS processes outlive the shell the CLI ends (as at
   * Stop, #52); whoever stopped it (the jobs window, the model's TaskStop), what is left
   * of its group is ended.
   */
  private readonly taskGroups = new Map<string, { shell: number; pgid: number }>();
  /** One shell lookup at a time, in task start order, so two tasks never take one shell. */
  private shellLookup: Promise<void> = Promise.resolve();
  /** Once the CLI sends `background_tasks_changed`, its level replaces the task_* edge count. */
  private backgroundLevelSeen = false;
  private readonly backgroundEdges = new Set<string>();
  private failureSignals: FailureSignals = {};
  private contextWindow = 0;
  /** The window the CLI reported per model, before the catalog's cap. */
  private readonly cliWindows = new Map<string, number>();
  /** `<model>:<limit>` of each real-window notice said in this chat: once is enough. */
  private readonly windowNotices = new Set<string>();
  private lastCostUsd = 0;
  private readonly session = {
    turns: 0,
    toolResults: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  private compacting: {
    resolve: (value: WorkerCompactResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private disposed = false;

  constructor(options: BridgeSessionRuntimeOptions, config: SdkHostConfig, log: Log) {
    this.options = options;
    this.config = config;
    this.log = log;
    this.modelRef = options.model;
    this.effort = options.effort;
    this.permissions =
      options.permissions ??
      (options.tier ? migratePermissionTier(options.tier) : { mode: 'agent', gear: 'ask' });
  }

  // ---- lifecycle ------------------------------------------------------------------

  async bootstrap(): Promise<WorkerBootstrapResult> {
    if (this.bootstrapResult) return this.bootstrapResult;
    const resumed = Boolean(this.options.sessionFile);
    if (this.options.sessionFile) {
      this.stubFile = this.options.sessionFile;
      this.stub = readStub(this.stubFile);
      // Main names the model it resumes with; an older Main may not, then the stub's is kept.
      this.modelRef ??= this.stub.model;
    } else {
      const created = createStub(
        this.config.configDir,
        this.options.logicalSessionId,
        this.options.cwd,
        this.modelRef
      );
      this.stubFile = created.file;
      this.stub = created.stub;
    }
    this.bootstrapResult = {
      bootstrapped: true,
      logicalSessionId: this.options.logicalSessionId,
      piSessionId: this.stub.ccSessionId,
      cwd: this.options.cwd,
      agentDir: this.config.configDir,
      sessionFile: this.stubFile,
      leaf: { activeEntryId: null, fileTailEntryId: null },
      ...(this.modelRef ? { model: this.modelRef } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      projectTrusted: this.options.projectTrusted,
      permissionGate: 'bundled',
      ...(resumed
        ? {
            initialHistory: await this.history({
              logicalSessionId: this.options.logicalSessionId,
              offset: 0,
              limit: 80,
            }),
          }
        : {}),
    };
    // A new chat is created on its first send: start the CLI now so the send
    // does not pay for the cold start. A reopened chat starts it on demand.
    if (!resumed) this.ensureQuery();
    return this.bootstrapResult;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.drainPending('session_closed');
    const toolProcesses = this.turn ? await this.toolProcessesForStop() : [];
    this.tracker.stop();
    this.input?.close();
    try {
      this.query?.close();
    } catch (error) {
      this.log('query close failed', error);
    }
    await Promise.race([this.pumpDone, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (toolProcesses.length > 0) await this.reapOrphans(toolProcesses, true);
  }

  private ensureQuery(): Query {
    if (this.query) return this.query;
    const stub = this.requireStub();
    const input = new InputQueue();
    const model = bareModelId(this.modelRef);
    // S-3 P-5, P-11: the user's home directory, and a probe's stand-in for it besides.
    const homes = [...new Set([homedir(), ...(this.config.homeDir ? [this.config.homeDir] : [])])];
    const projectTrusted =
      this.options.projectTrusted === true && !isUserHomeDir(this.options.cwd, homes);
    const options: Options = {
      cwd: this.options.cwd,
      env: this.config.cliEnv,
      ...(model ? { model } : {}),
      ...effortOptions(this.effort),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PILAB_PROMPT_APPEND },
      tools: { type: 'preset', preset: 'claude_code' },
      disallowedTools: HOST_ONLY_TOOLS,
      // No "Co-Authored-By" / "Generated with Claude Code" lines in the user's commits and PRs.
      // `env` is the flag tier, above the repository's settings: the gateway, the proxies
      // and the provider switches stay ours (decision 6). On the CLI's command line.
      // Plan mode is the CLI's own (ruling 20): Auto's check decides there as it does by
      // default (`useAutoModeDuringPlan`), and what it asks about is the user's card.
      settings: {
        attribution: false,
        // S-6 feedback 5 (user ruling 6): WebFetch asks api.anthropic.com whether a domain is
        // safe before every fetch; a network that cannot reach it (the encrypted machine's)
        // got every URL refused as unverifiable. The fetch itself still goes direct.
        skipWebFetchPreflight: true,
        env: this.config.settingsEnv,
        // S-3 P-5: the CLI reads CLAUDE.md and `.claude/rules` all the way up from the cwd,
        // the user's own `~/.claude` included; PiLab's user layer is its own config dir
        // (ruling 19), never `~/.claude`.
        claudeMdExcludes: userClaudeDirExcludes(this.options.cwd, homes),
        // User 2026-10-18: the CLI sizes a model from its own table (a Claude 5 model is 1M
        // there) and never reads the catalog; an administrator's smaller window holds here.
        ...catalogModelSettings(this.config.modelWindows),
      } as Options['settings'],
      // S-3 P-1, ruling 19: the user layer (the app's own config dir, `~/.pilab/<profile>/
      // claude`), and the project's and the user's private project settings (ruling 5);
      // project and local never for a scratch chat (decision 008 clause 5).
      settingSources: launchSettingSources(this.config.settingSources, projectTrusted),
      // A repository's hooks, allow rules and plugin marketplaces apply as the CLI applies
      // them (rulings 5, 18): no policy tier of PiLab's.
      // S-3 P-3: a project the user opened is trusted, or the CLI drops its allow rules.
      // Untyped in 0.3.300 (measured); recorded in the app-private config dir.
      ...(projectTrusted
        ? ({ workspaceTrust: { accepted: true, directory: this.options.cwd } } as Partial<Options>)
        : {}),
      // Only servers PiLab passes; never a repository's `.mcp.json`.
      strictMcpConfig: true,
      permissionMode: cliPermissionMode(this.permissions),
      // Set once at launch so a later switch to "bypass" is accepted; the mode itself stays ours.
      allowDangerouslySkipPermissions: true,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      ...(stub.started ? { resume: stub.ccSessionId } : { sessionId: stub.ccSessionId }),
      // The CLI Main chose (route B S-4 B-4). A .js CLI runs on this host's own node (the
      // app's whitelisted node.exe), never a `node` found on PATH; the SDK spawns
      // `executable` as given (its type lists names only) and ignores it for a native
      // binary, which it starts directly (0.3.300: decided by the file extension).
      ...(this.config.cliPath
        ? {
            pathToClaudeCodeExecutable: this.config.cliPath,
            executable: process.execPath as 'node',
          }
        : {}),
      stderr: (line: string) => this.log('[cli]', line.trimEnd()),
    };
    const q = query({ prompt: input, options });
    this.query = q;
    this.input = input;
    // S-5 H-4 (README §10.2 #42): the CLI starts on this mode, and answers a mode switch
    // only once it has initialized, which on a slow machine can outlast Main's budget.
    this.cliMode = cliPermissionMode(this.permissions);
    this.cliReady = false;
    q.initializationResult().then(
      (init) => {
        if (this.query !== q || this.disposed) return;
        this.cliReady = true;
        // Decision 194: the menu, before any message is sent.
        this.cliCommands = cliSlashCommands((init as { commands?: unknown } | undefined)?.commands);
        void this.sendDeferredMode(q);
      },
      () => {
        // A CLI that never initializes fails its turn through the pump.
      }
    );
    // A new CLI process starts with no background tasks; its level arrives on the first change.
    this.resetBackgroundTasks();
    this.pumpDone = this.pump(q);
    return q;
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        try {
          this.ingest(message);
        } catch (error) {
          this.log('ingest failed', error);
        }
      }
    } catch (error) {
      this.log('query ended with an error', error);
      if (this.turn) this.failTurn({ ...this.failureSignals, thrown: errorText(error) });
      this.compacting?.reject(error instanceof Error ? error : new Error(String(error)));
      this.compacting = null;
    } finally {
      if (this.query === q) {
        this.query = null;
        this.input = null;
        this.cliMode = null;
        // The CLI's tasks went with it.
        const hadTasks = this.backgroundTasks > 0;
        this.resetBackgroundTasks();
        if (this.board.settleAll()) this.applyBoard({ jobs: true, catalog: false, activity: [] });
        if (hadTasks && !this.turn) this.emitStatus('idle');
      }
      // The product UI never names Claude Code (plan hard constraint 4).
      if (this.turn && !this.disposed) this.failTurn({ cliExited: true });
    }
  }

  /** End the open turn as failed, with decision 7's code and a neutral sentence. */
  private failTurn(signals: SdkFailureSignals): void {
    const failure = mapSdkFailure(signals, this.config.secrets);
    // The CLI's own text can quote a gateway that echoes the key: redact before it reaches stderr.
    const cli = JSON.stringify({
      subtype: signals.result?.subtype,
      status: signals.result?.api_error_status,
      terminal: signals.result?.terminal_reason,
      assistantError: signals.assistantError,
      retry: signals.retry,
      text: signals.result?.result ?? signals.result?.errors ?? signals.thrown,
      cliExited: signals.cliExited,
    });
    this.log(
      `turn failed: code=${failure.errorCode ?? '(none)'} cli=${redactSecrets(cli, this.config.secrets)}`
    );
    this.endTurn('failed', {
      error: failure.error,
      ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    });
  }

  // ---- sends ----------------------------------------------------------------------

  async startSend(input: WorkerSendPayload): Promise<WorkerSendResult> {
    if (this.turn || this.compacting) {
      throw new BridgeSessionError('WORKER_SESSION_BUSY', 'A turn is already running', true);
    }
    if (input.mode === 'retry') {
      throw new BridgeSessionError(
        'WORKER_RETRY_UNAVAILABLE',
        'Retry is not available on the Claude SDK engine'
      );
    }
    const q = this.ensureQuery();
    await this.applySelection(q, input.model, input.effort);
    this.turnCount += 1;
    this.failureSignals = {};
    this.turn = {
      requestId: input.requestId,
      stopRequested: false,
      step: null,
      toolMessage: new Map(),
      toolOutcome: new Map(),
      refusals: new Map(),
      interjections: new Map(),
      shellCalls: new Set(),
    };
    if (this.turnCount === 1) {
      this.emit({ type: 'session.projection', payload: { key: 'todos', view: null } });
      this.emit({ type: 'session.projection', payload: { key: 'goal', view: null } });
      this.emit({
        type: 'session.projection',
        payload: { key: 'subagentCatalog', view: this.board.subagentCatalog() },
      });
    }
    this.emitStatus('running');
    const uuid = randomUUID();
    this.echoUser(input.attemptId, input.text, input.attachments, uuid);
    this.input?.push({
      type: 'user',
      message: { role: 'user', content: userContent(input.text, input.attachments) },
      parent_tool_use_id: null,
      uuid,
    });
    return { accepted: true, requestId: input.requestId };
  }

  private async applySelection(
    q: Query,
    model: string | undefined,
    effort: SessionEffortLevel | undefined
  ): Promise<void> {
    if (model && model !== this.modelRef) {
      const switched = await q.setModel(bareModelId(model)).then(
        () => true,
        (error) => {
          this.log('setModel failed', error);
          return false;
        }
      );
      // Only a switch the CLI took: the turn's label and the stub follow what really runs.
      if (switched) {
        this.modelRef = model;
        this.recordStubModel();
      }
    }
    if (effort && effort !== this.effort) {
      this.effort = effort;
      const level = effort === 'off' || effort === 'minimal' ? 'low' : effort;
      await this.applyFlagSettings(q, { effortLevel: level }).catch((error) =>
        this.log('effort change failed', error)
      );
    }
  }

  /**
   * Every flag-tier change goes through here. The CLI replaces a top-level key
   * whole, so a patch carrying `env` would drop the pinned variables (decision 6).
   */
  private applyFlagSettings(q: Query, patch: FlagSettingsPatch): Promise<void> {
    if ('env' in patch) return Promise.reject(new Error('flag settings may not carry env'));
    return q.applyFlagSettings(patch);
  }

  /** The stub's `model`: what Main resumes this chat with when it names none. */
  private recordStubModel(): void {
    const stub = this.stub;
    if (!stub || !this.modelRef || stub.model === this.modelRef) return;
    stub.model = this.modelRef;
    try {
      writeStub(this.stubFile, stub);
    } catch (error) {
      this.log('stub write failed', error);
    }
  }

  async stop(input: WorkerStopPayload): Promise<WorkerStopResult> {
    void input;
    const turn = this.turn;
    if (!turn) return { stopped: false };
    if (turn.stopRequested) return { stopped: true };
    turn.stopRequested = true;
    this.emitStatus('stopping');
    this.drainPending('aborted');
    // Windows: the CLI's interrupt leaves a Bash call's children running (see processTree.ts).
    // The latest background sample, never a sample taken here (#52).
    const toolProcesses = await this.toolProcessesForStop();
    const q = this.query;
    if (q) {
      await Promise.race([
        q.interrupt().catch((error) => this.log('interrupt failed', error)),
        new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS)),
      ]);
    }
    // The CLI closes an interrupted turn with a result; if it never does, close it here.
    turn.stopTimer = setTimeout(() => {
      if (this.turn === turn) this.endTurn('stopped', {});
    }, STOP_SETTLE_MS);
    if (toolProcesses.length > 0) {
      setTimeout(() => void this.reapOrphans(toolProcesses, false), 1_500);
    }
    return { stopped: true };
  }

  /** A shell call started: sample what it starts, in the background, until it ends. */
  private noteToolStarted(turn: Turn, toolCallId: string, name: string): void {
    if (!SHELL_TOOLS.has(name)) return;
    turn.shellCalls.add(toolCallId);
    this.tracker.start();
  }

  private noteToolEnded(turn: Turn, toolCallId: string): void {
    if (turn.shellCalls.delete(toolCallId) && turn.shellCalls.size === 0) this.tracker.stop();
  }

  /**
   * What Stop (or dispose) ends afterwards: the latest background sample, and on Windows
   * what its shells have started since, from Git Bash's own process table (quick, unlike
   * the Windows one: a command's `sleep`s may well postdate the latest sample).
   */
  private async toolProcessesForStop(): Promise<ProcessRow[]> {
    const rows = await this.tracker.latest(STOP_SAMPLE_WAIT_MS);
    if (process.platform !== 'win32' || !this.config.gitBashPath) return rows;
    const shells = rows.filter((row) => !row.msys && /^bash\.exe$/i.test(row.name));
    if (shells.length === 0) return rows;
    const msys = await msysToolProcesses(this.config.gitBashPath, shells, STOP_SAMPLE_WAIT_MS);
    const fresh = msys.filter((row) => !rows.some((r) => r.pid === row.pid));
    if (fresh.length > 0) {
      this.log(
        `msys tool processes at stop: ${fresh.map((row) => `${row.name}#${row.pid}`).join(' ')}`
      );
    }
    return [...rows, ...fresh];
  }

  /**
   * Processes under the CLI (its own children's descendants): what a tool call started.
   * One background sample of the tracker; undefined when the sample itself failed (the
   * table is never empty otherwise: this host is in it).
   */
  private async collectToolProcesses(): Promise<ProcessRow[] | undefined> {
    const started = Date.now();
    const table = await sampleProcesses({ log: (message) => this.log(message) });
    if (table.size === 0) return undefined;
    const all = descendantsOf(process.pid, table);
    this.log(
      `process snapshot: ${table.size} rows in ${Date.now() - started} ms, host ${process.pid} (${table.get(process.pid)?.name ?? 'missing'}), descendants ${all.map((row) => `${row.name}#${row.pid}<${row.ppid}`).join(' ')}`
    );
    const tools = all.filter((row) => row.ppid !== process.pid);
    if (process.platform === 'win32' && this.config.gitBashPath) {
      const shells = all.filter((row) => /^bash\.exe$/i.test(row.name));
      const msys = await msysToolProcesses(this.config.gitBashPath, shells);
      this.log(
        `msys tool processes: ${msys.map((row) => `${row.name}#${row.pid}`).join(' ') || '(none)'}`
      );
      tools.push(...msys.filter((row) => !tools.some((t) => t.pid === row.pid)));
    }
    return tools;
  }

  private async reapOrphans(before: ProcessRow[], all: boolean): Promise<void> {
    const killed = reap(before, await sampleProcesses({ log: (m) => this.log(m) }), all);
    if (killed.length > 0) {
      this.log(
        `reaped ${killed.length} process(es) left by the CLI: ${killed.map((row) => `${row.name}#${row.pid}`).join(', ')}`
      );
    }
  }

  interject(input: WorkerInterjectPayload): WorkerInterjectResult {
    const turn = this.turn;
    if (!turn || !this.input || turn.stopRequested) {
      return { interjected: false, turnActive: Boolean(turn) };
    }
    const uuid = randomUUID();
    turn.interjections.set(uuid, {
      attemptId: input.attemptId,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.sendNow === true ? { sendNow: 'pending' as const } : {}),
    });
    // `next`: folded into the running turn at its next step boundary.
    this.input.push({
      type: 'user',
      message: { role: 'user', content: userContent(input.text, input.attachments) },
      parent_tool_use_id: null,
      uuid,
      priority: 'next',
    });
    return { interjected: true, turnActive: true };
  }

  /**
   * Decision 201, "Send now": the CLI's own Send now (an `interrupt` with
   * `send_now`), not a Stop. The running step is cut short and the message
   * reaches the model at once; background agents and commands keep running.
   * A CLI that does not advertise it would take the request as a plain
   * interrupt, which ends them: there the message waits for the next step
   * boundary, as Ctrl+Enter's does (the lifecycle handler never asks it then).
   */
  private deliverNow(uuid: string): void {
    const request = (
      this.query as unknown as {
        request?: (
          body: Record<string, unknown>
        ) => Promise<{ response?: Record<string, unknown> }>;
      } | null
    )?.request;
    void request
      ?.call(this.query, { subtype: 'interrupt', send_now: true, message_uuid: uuid })
      .then((answer) => this.log(`send now ${uuid}: ${String(answer?.response?.send_now ?? '-')}`))
      .catch((error) => this.log('send now failed', error));
  }

  /**
   * Take a Ctrl+Enter message back before the turn folds it in, through the
   * CLI's own `cancel_async_message` (`Query.cancelAsyncMessage`, present in
   * sdk.mjs but not in the published types). The bridge's interface is
   * synchronous, so a cancel racing the fold is answered `withdrawn` before the
   * CLI says whether it won; a product build would make this asynchronous.
   */
  withdrawInterjection(input: { attemptId: string }): WorkerInterjectWithdrawResult {
    const turn = this.turn;
    const entry = turn
      ? [...turn.interjections].find(([, value]) => value.attemptId === input.attemptId)
      : undefined;
    if (!turn || !entry) return { outcome: 'not_found' };
    const [uuid, pending] = entry;
    // A CLI turn already runs on it: it was delivered, whatever the bubble still says.
    if (pending.cliState === 'started') return { outcome: 'delivered' };
    turn.interjections.delete(uuid);
    const cancel = (
      this.query as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> } | null
    )?.cancelAsyncMessage;
    void cancel
      ?.call(this.query, uuid)
      .then((cancelled) => {
        this.log(`withdraw ${uuid}: ${cancelled ? 'cancelled' : 'already taken in'}`);
        if (cancelled) this.releaseHeldTurn();
      })
      .catch((error) => this.log('withdraw failed', error));
    // No cancel to wait for (an SDK without it): a turn held only for this message ends now.
    if (!cancel) this.releaseHeldTurn();
    return { outcome: 'withdrawn' };
  }

  // ---- event mapping --------------------------------------------------------------

  private emit(event: EventBody): void {
    if (this.disposed && event.type !== 'permission.resolved' && event.type !== 'question.resolved')
      return;
    this.options.emit({
      ...event,
      sessionId: this.options.logicalSessionId,
      ...(this.turn ? { requestId: this.turn.requestId } : {}),
    } as RuntimeEventDraft);
  }

  /** `session.status`, always with the live background-task count (decision 8). */
  private emitStatus(
    status: 'running' | 'stopping' | 'idle',
    retry?: Extract<EventBody, { type: 'session.status' }>['payload']['retry']
  ): void {
    this.emit({
      type: 'session.status',
      payload: { status, ...(retry ? { retry } : {}), backgroundTasks: this.backgroundTasks },
    });
  }

  /** The status a background-task change is reported under: the open turn's, else idle. */
  private currentStatus(): 'running' | 'stopping' | 'idle' {
    if (!this.turn) return 'idle';
    return this.turn.stopRequested ? 'stopping' : 'running';
  }

  private setBackgroundTasks(count: number): void {
    if (count === this.backgroundTasks) return;
    this.backgroundTasks = count;
    this.emitStatus(this.currentStatus());
  }

  private resetBackgroundTasks(): void {
    this.backgroundTasks = 0;
    this.backgroundLevelSeen = false;
    this.backgroundEdges.clear();
  }

  /** `uuid`: the one the message went to the CLI with, which its transcript row keeps (decision 206). */
  private echoUser(
    attemptId: string | undefined,
    text: string,
    attachments: SessionAttachment[] | undefined,
    uuid: string
  ): void {
    this.userMessageCount += 1;
    const messageId = `cc-user-${this.idTag}-${this.userMessageCount}`;
    this.emit({
      type: 'message.started',
      payload: {
        messageId,
        role: 'user',
        transcriptId: uuid,
        ...(attemptId ? { attemptId } : {}),
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                kind: a.kind,
                mediaType: a.mediaType,
                ...(a.name ? { name: a.name } : {}),
              })),
            }
          : {}),
      },
    });
    if (text)
      this.emit({
        type: 'message.delta',
        payload: { messageId, blockId: `${messageId}-text`, text },
      });
    this.emit({ type: 'message.completed', payload: { messageId } });
  }

  private ingest(message: SDKMessage): void {
    if (process.env.AICLIENT_CLAUDE_SDK_TRACE) {
      const m = message as unknown as Record<string, unknown>;
      const event = m.type === 'stream_event' ? (record(m.event)?.type as string) : '';
      if (event !== 'content_block_delta') {
        this.log(
          `[trace] ${m.type}${m.subtype ? `/${m.subtype}` : ''}${event ? `/${event}` : ''} uuid=${String(m.uuid ?? '')} umu=${JSON.stringify(m.user_message_uuids ?? m.user_message_uuid ?? null)} ${m.type === 'result' ? `qtc=${String(m.queued_turn_count)} ` : ''}${m.type === 'user' || m.type === 'command_lifecycle' ? JSON.stringify(m).slice(0, 300) : ''}`
        );
      }
    }
    const consumed = (message as { user_message_uuids?: unknown }).user_message_uuids;
    if (Array.isArray(consumed))
      this.echoTakenInterjections(consumed.filter((u): u is string => typeof u === 'string'));
    switch (message.type) {
      case 'system':
        this.ingestSystem(message as unknown as Record<string, unknown>);
        return;
      case 'stream_event':
        if (message.parent_tool_use_id === null) this.ingestStream(message);
        return;
      case 'assistant':
        if (message.parent_tool_use_id === null) this.ingestAssistant(message);
        else this.applySubagentThread(message as unknown as Record<string, unknown>);
        return;
      case 'user':
        if (message.parent_tool_use_id === null)
          this.ingestUser(message as unknown as Record<string, unknown>);
        else this.applySubagentThread(message as unknown as Record<string, unknown>);
        return;
      case 'result':
        this.ingestResult(message as unknown as Record<string, unknown>);
        return;
      default:
        if ((message as { type: string }).type === 'command_lifecycle')
          this.ingestCommandLifecycle(message as unknown as Record<string, unknown>);
        return;
    }
  }

  /**
   * The CLI's per-command lifecycle (2.1.300, untyped): `queued` → `started` → `completed`,
   * or `cancelled`. Only our own Ctrl+Enter messages are tracked here: a message the turn
   * never folded in at a step boundary runs as the CLI's next turn, and `queued_turn_count`
   * on the result before it does not count such a message (measured: 0), so this is how
   * the host knows to keep the product turn open for it.
   */
  private ingestCommandLifecycle(message: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) {
      // Not ours (every send and Ctrl+Enter message has an open turn): a schedule came due.
      if (message.state === 'started') this.scheduledWake = true;
      return;
    }
    const uuid = String(message.command_uuid ?? '');
    const pending = turn.interjections.get(uuid);
    if (!pending) return;
    const state = message.state;
    if (state === 'queued' || state === 'started') {
      pending.cliState = state;
      // Decision 201: waiting in the CLI's queue now, so its Send now finds it.
      // Asked then, not at the interjection: a first send can be interjected into before
      // the CLI's `system/init` named its capabilities (measured: the probe's did).
      if (state === 'queued' && pending.sendNow === 'pending') {
        pending.sendNow = 'sent';
        // A Stop pressed meanwhile already interrupted the turn; a Send now on top
        // would only cut short whatever runs next. The message waits as a Ctrl+Enter's.
        if (turn.stopRequested) this.log(`send now ${uuid}: skipped, the turn is stopping`);
        else if (this.cliSendNow) this.deliverNow(uuid);
        else this.log(`send now: the CLI has no ${SEND_NOW_CAPABILITY}; delivered as Ctrl+Enter`);
      }
      return;
    }
    if (state === 'cancelled') {
      turn.interjections.delete(uuid);
      this.releaseHeldTurn();
      return;
    }
    // Done, yet no turn named it in `user_message_uuids`: it was delivered all the same,
    // so the bubble settles and a turn held for it does not wait for good.
    if (state === 'completed') {
      this.echoTakenInterjections([uuid]);
      this.releaseHeldTurn();
    }
  }

  /** A turn held only for Ctrl+Enter messages that are all gone now ends as completed. */
  private releaseHeldTurn(): void {
    const turn = this.turn;
    if (!turn?.heldForInterjection || turn.interjections.size > 0) return;
    turn.heldForInterjection = false;
    this.session.turns += 1;
    this.failureSignals = {};
    this.endTurn(turn.stopRequested ? 'stopped' : 'completed', {});
  }

  /** S-6 feedback 4: what the board says changed, as projections and lane events. */
  private applyBoard(change: BoardChange): void {
    if (change.jobs) {
      this.emit({ type: 'session.projection', payload: { key: 'jobs', view: this.board.jobs() } });
    }
    if (change.catalog) {
      this.emit({
        type: 'session.projection',
        payload: { key: 'subagentCatalog', view: this.board.subagentCatalog() },
      });
    }
    for (const payload of change.activity) this.emit({ type: 'subagent.activity', payload });
  }

  /** A subagent's own thread (S-6 feedback 4): its lane's text and tool calls. */
  private applySubagentThread(message: Record<string, unknown>): void {
    const activity = this.board.ingestSubagentMessage(message);
    if (activity.length > 0) this.applyBoard({ jobs: false, catalog: false, activity });
  }

  private ingestSystem(message: Record<string, unknown>): void {
    this.applyBoard(this.board.ingestSystem(message));
    const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
    if (taskId && message.subtype === 'task_started' && this.board.kindOf(taskId) === 'bash') {
      this.noteTaskShell(taskId);
    }
    if (taskId && message.subtype === 'task_notification') {
      this.settleTaskShell(taskId, message.status);
    }
    switch (message.subtype) {
      case 'init': {
        // Decision 194: the CLI names the rows bound to a terminal here only.
        if (Array.isArray(message.terminal_slash_commands)) {
          this.terminalCommands = message.terminal_slash_commands.filter(
            (c): c is string => typeof c === 'string'
          );
        }
        // Decision 201: re-emitted inits carry the current list; the newest wins.
        if (Array.isArray(message.capabilities)) {
          this.cliSendNow = message.capabilities.includes(SEND_NOW_CAPABILITY);
        }
        const stub = this.stub;
        if (stub && !stub.started) {
          stub.started = true;
          writeStub(this.stubFile, stub);
        }
        // The CLI is up on `modelRef` (a resume may start on another model than the stub's).
        this.recordStubModel();
        this.noteCliMode(message.permissionMode);
        return;
      }
      case 'status': {
        // S-2 A-6: every mode change, the CLI's own included (plan mode entered or left).
        this.noteCliMode(message.permissionMode);
        return;
      }
      case 'commands_changed': {
        // Decision 194: the whole list again (skills found mid-session, `/reload-skills`).
        this.cliCommands = cliSlashCommands(message.commands);
        return;
      }
      case 'permission_denied': {
        // S-2: a call the CLI refused with no card (Auto's safety check, a mode or a rule).
        // Its own sentence names Claude Code (plan §2 rule 4): the row says it our way.
        const id = typeof message.tool_use_id === 'string' ? message.tool_use_id : '';
        if (!id || !this.turn) return;
        this.turn.toolOutcome.set(id, 'refused');
        this.turn.refusals.set(
          id,
          cliRefusalText(message.decision_reason_type, message.decision_reason)
        );
        return;
      }
      case 'background_tasks_changed': {
        // The level signal: replace, never pair edges (sdk.d.ts SDKBackgroundTasksChangedMessage).
        this.backgroundLevelSeen = true;
        this.backgroundEdges.clear();
        const tasks = Array.isArray(message.tasks) ? message.tasks : [];
        this.setBackgroundTasks(tasks.filter((task) => record(task)?.ambient !== true).length);
        return;
      }
      case 'task_started': {
        const kind = String(message.task_type ?? '');
        if (/agent/i.test(kind) || typeof message.subagent_type === 'string') {
          this.agentTaskIds.add(String(message.task_id));
        }
        // Edge count, only for a CLI that never sent the level.
        if (!this.backgroundLevelSeen && message.ambient !== true) {
          this.backgroundEdges.add(String(message.task_id));
          this.setBackgroundTasks(this.backgroundEdges.size);
        }
        return;
      }
      case 'task_notification': {
        this.lastTaskWasAgent = this.agentTaskIds.delete(String(message.task_id));
        this.scheduledWake = false;
        if (!this.backgroundLevelSeen && this.backgroundEdges.delete(String(message.task_id))) {
          this.setBackgroundTasks(this.backgroundEdges.size);
        }
        return;
      }
      case 'api_retry': {
        const attempt = num(message.attempt);
        const delayMs = num(message.retry_delay_ms);
        this.failureSignals.retry = {
          ...(typeof message.error === 'string' ? { error: message.error } : {}),
          error_status: typeof message.error_status === 'number' ? message.error_status : null,
          ...(message.no_response ? { no_response: message.no_response } : {}),
        };
        this.emitStatus('running', {
          attempt,
          maxRetries: num(message.max_retries),
          delayMs,
          errorStatus: message.error_status == null ? null : String(message.error_status),
          error: typeof message.error === 'string' ? message.error : 'unknown',
          retryAt: Date.now() + delayMs,
        });
        return;
      }
      default:
        return;
    }
  }

  private ingestStream(message: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const event = message.event as unknown as Record<string, unknown>;
    // A turn the CLI started by itself (a background agent or command finished): open it here.
    if (!this.turn && event.type === 'message_start' && !this.compacting && !this.disposed)
      this.openEngineTurn();
    const turn = this.turn;
    if (!turn) return;
    switch (event.type) {
      case 'message_start': {
        // A request answered: an earlier retry of this turn is no longer what the turn ends on.
        delete this.failureSignals.retry;
        this.closeStep();
        const apiMessage = record(event.message) ?? {};
        const usage = record(apiMessage.usage) ?? {};
        const stepNo = this.nextStepNo();
        const messageId = `${this.stepIdPrefix()}-s${stepNo}`;
        turn.step = {
          messageId,
          apiMessageId: String(apiMessage.id ?? messageId),
          blocks: new Map(),
          promptTokens: {
            input: num(usage.input_tokens),
            cacheRead: num(usage.cache_read_input_tokens),
            cacheWrite: num(usage.cache_creation_input_tokens),
          },
          output: 0,
        };
        this.emit({
          type: 'message.started',
          payload: {
            messageId,
            role: 'assistant',
            // Decision 206: the transcript keeps this id on every row of the step.
            ...(typeof apiMessage.id === 'string' ? { transcriptId: apiMessage.id } : {}),
            ...(this.modelRef ? { model: this.modelRef } : {}),
          },
        });
        const interim = buildPiInterimUsagePayload({
          input: turn.step.promptTokens.input,
          cacheRead: turn.step.promptTokens.cacheRead,
          cacheWrite: turn.step.promptTokens.cacheWrite,
        });
        if (interim) this.emit({ type: 'usage.updated', payload: interim });
        return;
      }
      case 'content_block_start': {
        const step = turn.step;
        if (!step) return;
        const index = num(event.index);
        const block = record(event.content_block) ?? {};
        if (block.type === 'text') {
          step.blocks.set(index, { kind: 'text', blockId: `${step.messageId}-b${index}` });
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const blockId = `${step.messageId}-r${index}`;
          step.blocks.set(index, { kind: 'thinking', blockId });
          this.emit({ type: 'thinking.started', payload: { messageId: step.messageId, blockId } });
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const toolCallId = String(block.id);
          const name = String(block.name);
          step.blocks.set(index, { kind: 'tool', blockId: toolCallId, toolCallId, name, json: '' });
          turn.toolMessage.set(toolCallId, step.messageId);
          this.noteToolStarted(turn, toolCallId, name);
          this.emit({
            type: 'tool.started',
            payload: {
              messageId: step.messageId,
              toolCallId,
              name,
              input: { __streaming: { bytes: 0, lines: 0 } },
            },
          });
        }
        return;
      }
      case 'content_block_delta': {
        const step = turn.step;
        const block = step?.blocks.get(num(event.index));
        const delta = record(event.delta) ?? {};
        if (!step || !block) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit({
            type: 'message.delta',
            payload: { messageId: step.messageId, blockId: block.blockId, text: delta.text },
          });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.emit({
            type: 'thinking.delta',
            payload: { messageId: step.messageId, blockId: block.blockId, text: delta.thinking },
          });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.json = (block.json ?? '') + delta.partial_json;
        }
        return;
      }
      case 'content_block_stop': {
        const step = turn.step;
        const block = step?.blocks.get(num(event.index));
        if (!step || !block) return;
        if (block.kind === 'thinking') {
          this.emit({
            type: 'thinking.completed',
            payload: { messageId: step.messageId, blockId: block.blockId },
          });
        } else if (block.kind === 'tool' && block.toolCallId) {
          let input: unknown = {};
          try {
            input = block.json ? JSON.parse(block.json) : {};
          } catch {
            input = { __unparsed: block.json };
          }
          this.emit({
            type: 'tool.updated',
            payload: { messageId: step.messageId, toolCallId: block.toolCallId, input },
          });
          this.streamedInputs.set(block.toolCallId, input);
          this.streamedWaiters.get(block.toolCallId)?.(input);
          this.streamedWaiters.delete(block.toolCallId);
        }
        return;
      }
      case 'message_delta': {
        const step = turn.step;
        const usage = record(event.usage);
        if (step && usage) {
          step.output = num(usage.output_tokens) || step.output;
          if (usage.input_tokens !== undefined) step.promptTokens.input = num(usage.input_tokens);
          if (usage.cache_read_input_tokens !== undefined) {
            step.promptTokens.cacheRead = num(usage.cache_read_input_tokens);
          }
          if (usage.cache_creation_input_tokens !== undefined) {
            step.promptTokens.cacheWrite = num(usage.cache_creation_input_tokens);
          }
        }
        return;
      }
      case 'message_stop': {
        const step = turn.step;
        if (step) this.settleStepUsage(step);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The SDK's complete assistant frame: used to recover a tool input the stream
   * could not parse, and for the `error` class of the CLI's synthetic API-error
   * reply (decision 7; its text is the CLI's hint and is never shown).
   */
  private ingestAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    if (message.error) {
      this.failureSignals.assistantError = message.error;
      // User 2026-10-18: the reply quotes the service's refusal, its limit included.
      this.noticeContextWindow(assistantText(message.message as { content?: unknown }));
    }
    const turn = this.turn;
    // Decision 194: a local command's output (`/context`, `/usage`, …) comes as one
    // message of the CLI's own, with no stream frames: shown as the turn's reply.
    if (turn && !turn.step && !message.error) {
      const apiMessage = message.message as { model?: unknown; content?: unknown };
      const text = apiMessage.model === SYNTHETIC_MODEL ? assistantText(apiMessage) : '';
      if (text.trim()) {
        this.emitLocalReply(turn, text);
        return;
      }
    }
    const step = turn?.step;
    if (!turn || !step) return;
    const content = (message.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = record(block);
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      if (!turn.toolMessage.has(b.id)) {
        // No stream frames for this call (a gateway that does not stream): open the row now.
        turn.toolMessage.set(b.id, step.messageId);
        this.noteToolStarted(turn, b.id, String(b.name));
        this.emit({
          type: 'tool.started',
          payload: {
            messageId: step.messageId,
            toolCallId: b.id,
            name: String(b.name),
            input: b.input ?? {},
          },
        });
      }
    }
  }

  /** One whole reply of the CLI's own, as a model step would stream it (decision 194). */
  private emitLocalReply(turn: Turn, text: string): void {
    const messageId = `${this.stepIdPrefix()}-s${this.nextStepNo()}`;
    turn.step = {
      messageId,
      apiMessageId: messageId,
      blocks: new Map([[0, { kind: 'text', blockId: `${messageId}-b0` }]]),
      promptTokens: { input: 0, cacheRead: 0, cacheWrite: 0 },
      output: 0,
    };
    this.emit({ type: 'message.started', payload: { messageId, role: 'assistant' } });
    this.emit({
      type: 'message.delta',
      payload: { messageId, blockId: `${messageId}-b0`, text },
    });
  }

  private ingestUser(message: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) return;
    const content = record(message.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = record(block);
      if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const toolCallId = b.tool_use_id;
      this.noteToolEnded(turn, toolCallId);
      const messageId = turn.toolMessage.get(toolCallId) ?? turn.step?.messageId;
      if (!messageId) continue;
      const raw = textOf(b.content);
      const failed = b.is_error === true;
      const text = turn.refusals.get(toolCallId) ?? (failed ? cliRefusalRewrite(raw) : raw);
      const outcome =
        turn.toolOutcome.get(toolCallId) ??
        (failed && (turn.stopRequested || /interrupted by user/i.test(text))
          ? ('stopped' as const)
          : undefined);
      this.session.toolResults += 1;
      if (outcome) {
        this.emit({
          type: 'tool.completed',
          payload: {
            messageId,
            toolCallId,
            ok: false,
            output: { content: [{ type: 'text', text }], details: { [outcome]: true } },
            error:
              text ||
              (outcome === 'refused'
                ? 'Refused'
                : outcome === 'stopped'
                  ? 'Stopped'
                  : 'Not started'),
          },
        });
      } else {
        this.emit({
          type: 'tool.completed',
          payload: {
            messageId,
            toolCallId,
            ok: !failed,
            output: text,
            ...(failed ? { error: text || 'Tool call failed' } : {}),
          },
        });
      }
    }
  }

  /**
   * User 2026-10-18: a refusal for size that names the service's limit, below
   * the window the chat's model is set to (the catalog's, else the CLI's own):
   * the setting is wrong, and the timeline says so once. The CLI still
   * compacts and retries by itself where it can.
   */
  private noticeContextWindow(errorText: string): void {
    if (!errorText) return;
    const model = bareModelId(this.modelRef) ?? '';
    const declared =
      this.config.modelWindows && Object.hasOwn(this.config.modelWindows, model)
        ? this.config.modelWindows[model]
        : undefined;
    const configured = declared ?? this.cliWindows.get(model);
    const notice = contextWindowNotice({ errorText, configured, model });
    if (!notice) return;
    const said = `${notice.params.model}:${notice.limit}`;
    if (this.windowNotices.has(said)) return;
    this.windowNotices.add(said);
    this.log(
      `context window: the service takes ${notice.limit} tokens for ${model}, set to ${notice.configured}`
    );
    this.emit({
      type: 'custom.message',
      payload: {
        messageId: `ccsdk-notice-${CONTEXT_WINDOW_NOTICE_KIND}-${randomUUID()}`,
        customType: `${DSH_NOTICE_CUSTOM_TYPE_PREFIX}${CONTEXT_WINDOW_NOTICE_KIND}`,
        content: notice.text,
        notice: { key: notice.key, params: notice.params },
      },
    });
  }

  private ingestResult(message: Record<string, unknown>): void {
    const cost = num(message.total_cost_usd);
    const costDelta = Math.max(0, cost - this.lastCostUsd);
    this.lastCostUsd = cost;
    const modelUsage = record(message.modelUsage);
    if (modelUsage) {
      for (const [model, entry] of Object.entries(modelUsage)) {
        const reported = num(record(entry)?.contextWindow);
        if (reported > 0) this.cliWindows.set(model, reported);
        const window = cappedContextWindow(reported, this.config.modelWindows, model);
        if (window > this.contextWindow) this.contextWindow = window;
      }
    }
    if (message.is_error === true) {
      const errors = Array.isArray(message.errors) ? message.errors : [];
      this.noticeContextWindow(
        [message.result, ...errors].filter((part) => typeof part === 'string').join('\n')
      );
    }
    this.session.costUsd += costDelta;
    if (this.compacting) {
      const done = this.compacting;
      this.compacting = null;
      this.failureSignals = {};
      if (message.is_error === true)
        done.reject(new Error(String(message.result ?? 'compaction failed')));
      else done.resolve({ compacted: true });
      return;
    }
    const turn = this.turn;
    if (!turn) {
      this.failureSignals = {};
      return;
    }
    // A Ctrl+Enter message the turn never took in runs as the CLI's next turn:
    // keep this product turn open so it lands under the same request. The CLI says so
    // through `command_lifecycle` (its `queued_turn_count` leaves such a message out);
    // a CLI that sends no lifecycle frames is judged by the count, as before.
    if (turn.interjections.size > 0 && !turn.stopRequested) {
      const queuedInCli = [...turn.interjections.values()].some((i) => i.cliState !== undefined);
      if (queuedInCli || num(message.queued_turn_count) > 0) {
        turn.heldForInterjection = true;
        return;
      }
    }
    turn.heldForInterjection = false;
    this.session.turns += 1;
    const signals = this.failureSignals;
    this.failureSignals = {};
    if (turn.stopRequested) {
      this.endTurn('stopped', {});
    } else if (message.is_error === true || message.subtype !== 'success') {
      this.failTurn({
        ...signals,
        result: {
          ...(typeof message.subtype === 'string' ? { subtype: message.subtype } : {}),
          is_error: message.is_error === true,
          api_error_status:
            typeof message.api_error_status === 'number' ? message.api_error_status : null,
          ...(typeof message.terminal_reason === 'string'
            ? { terminal_reason: message.terminal_reason }
            : {}),
          ...(Array.isArray(message.errors)
            ? { errors: message.errors.filter((e): e is string => typeof e === 'string') }
            : {}),
          ...(typeof message.result === 'string' ? { result: message.result } : {}),
        },
      });
    } else {
      this.endTurn('completed', {});
    }
  }

  /**
   * A turn nobody sent: the CLI woke itself for a task notification. Shaped
   * like the DSH bridge's own engine turns: its own request id and a user head
   * with an `origin` instead of typed text.
   */
  private openEngineTurn(): void {
    this.turnCount += 1;
    this.turn = {
      requestId: `cc-turn-${this.requireStub().ccSessionId.slice(0, 8)}-${this.idTag}-${this.turnCount}`,
      stopRequested: false,
      step: null,
      toolMessage: new Map(),
      toolOutcome: new Map(),
      refusals: new Map(),
      interjections: new Map(),
      shellCalls: new Set(),
    };
    this.emitStatus('running');
    this.userMessageCount += 1;
    const messageId = `cc-user-${this.idTag}-${this.userMessageCount}`;
    this.emit({
      type: 'message.started',
      payload: {
        messageId,
        role: 'user',
        origin: this.scheduledWake
          ? { kind: 'scheduled' }
          : this.lastTaskWasAgent
            ? { kind: 'subagent' }
            : { kind: 'job' },
      },
    });
    this.emit({ type: 'message.completed', payload: { messageId } });
  }

  /** A model step's id up to its step number (decision 204: with this host's mark). */
  private stepIdPrefix(): string {
    return `cc-${this.requireStub().ccSessionId.slice(0, 8)}-${this.idTag}-t${this.turnCount}`;
  }

  private nextStepNo(): number {
    const turn = this.turn;
    if (!turn) return 0;
    const current = turn.step?.messageId.match(/-s(\d+)$/)?.[1];
    return current ? Number(current) + 1 : 1;
  }

  private closeStep(): void {
    const turn = this.turn;
    if (!turn?.step) return;
    this.emit({ type: 'message.completed', payload: { messageId: turn.step.messageId } });
  }

  private settleStepUsage(step: Step): void {
    const { input, cacheRead, cacheWrite } = step.promptTokens;
    const output = step.output;
    const totalTokens = input + cacheRead + cacheWrite + output;
    this.session.input += input;
    this.session.output += output;
    this.session.cacheRead += cacheRead;
    this.session.cacheWrite += cacheWrite;
    this.session.totalTokens += totalTokens;
    const contextTokens = input + cacheRead + cacheWrite + output;
    const payload = buildPiUsagePayload(
      { input, output, cacheRead, cacheWrite, totalTokens, cost: { total: 0 } },
      this.contextWindow > 0
        ? {
            tokens: contextTokens,
            contextWindow: this.contextWindow,
            percent: Math.min(100, (contextTokens / this.contextWindow) * 100),
          }
        : undefined,
      { ...this.session }
    );
    if (payload) this.emit({ type: 'usage.updated', payload });
  }

  private echoTakenInterjections(uuids: string[]): void {
    const turn = this.turn;
    if (!turn || turn.interjections.size === 0) return;
    for (const uuid of uuids) {
      const pending = turn.interjections.get(uuid);
      if (!pending) continue;
      turn.interjections.delete(uuid);
      this.echoUser(pending.attemptId, pending.text, pending.attachments, uuid);
    }
  }

  private endTurn(
    outcome: 'completed' | 'failed' | 'stopped',
    payload: { error?: string; errorCode?: string }
  ): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
    this.tracker.stop();
    this.closeStep();
    this.drainPending(outcome === 'stopped' ? 'aborted' : 'session_closed');
    const type =
      outcome === 'completed'
        ? 'session.completed'
        : outcome === 'stopped'
          ? 'session.stopped'
          : 'session.failed';
    this.emit({ type, payload });
    this.emitStatus('idle');
    this.turn = null;
  }

  // ---- approvals and questions ----------------------------------------------------

  /**
   * The CLI's mode decides what needs asking, and the host never answers for the
   * user: everything that reaches here (an ask in Manual, a call Auto's check hands
   * to a person, a safety check Bypass does not skip, a change in plan mode) is the
   * user's card. Plan mode is the CLI's own (ruling 20, official behaviour).
   */
  private readonly canUseTool: CanUseTool = (toolName, input, opts) => {
    if (process.env.AICLIENT_CLAUDE_SDK_TRACE) {
      this.log(
        `[trace] canUseTool ${toolName} id=${opts.toolUseID} mode=${cliPermissionMode(this.permissions)}`
      );
    }
    if (toolName === 'AskUserQuestion') return this.askQuestion(input, opts.toolUseID, opts.signal);
    if (toolName === 'ExitPlanMode') return this.reviewPlan(input, opts.toolUseID, opts.signal);
    return this.askPermission(toolName, input, opts);
  };

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    const permissionId = opts.toolUseID;
    const described = describeCall(toolName, input, this.options.cwd);
    this.emit({
      type: 'permission.requested',
      payload: {
        permissionId,
        toolName,
        ...described,
        // "Allow for session" only when it remembers something: the CLI offers no rule for
        // a call it marks `suppressAlwaysAllowRule` (a safety check, a classifier escalation).
        decisions:
          !opts.suppressAlwaysAllowRule && (opts.suggestions?.length ?? 0) > 0
            ? ['allow', 'allow_session', 'deny']
            : ['allow', 'deny'],
        ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
        ...(opts.agentID ? { agentId: opts.agentID } : {}),
      },
    });
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(permissionId, {
        toolName,
        input,
        ...(opts.suggestions ? { suggestions: opts.suggestions } : {}),
        resolve,
      });
      opts.signal.addEventListener(
        'abort',
        () => this.autoSettlePermission(permissionId, 'aborted'),
        {
          once: true,
        }
      );
    });
  }

  respondPermission(input: { permissionId: string; decision: PermissionDecisionId }): boolean {
    const pending = this.pendingPermissions.get(input.permissionId);
    if (!pending) return false;
    this.pendingPermissions.delete(input.permissionId);
    const allow = input.decision === 'allow' || input.decision === 'allow_session';
    this.emit({
      type: 'permission.resolved',
      payload: { permissionId: input.permissionId, allow, decision: input.decision },
    });
    if (allow) {
      // "Allow for session" keeps the CLI's own suggestions, pinned to this session only:
      // nothing is written to the project's or the user's settings files.
      const sessionRules =
        input.decision === 'allow_session'
          ? (pending.suggestions ?? []).map((update) => ({
              ...update,
              destination: 'session' as const,
            }))
          : [];
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(sessionRules.length > 0 ? { updatedPermissions: sessionRules } : {}),
      });
    } else {
      this.turn?.toolOutcome.set(input.permissionId, 'refused');
      pending.resolve({
        behavior: 'deny',
        message: 'The user declined this tool call.',
        ...(input.decision === 'cancel' ? { interrupt: true } : {}),
      });
    }
    return true;
  }

  private autoSettlePermission(permissionId: string, reason: 'aborted' | 'session_closed'): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;
    this.pendingPermissions.delete(permissionId);
    this.turn?.toolOutcome.set(permissionId, 'notStarted');
    this.emit({
      type: 'permission.resolved',
      payload: { permissionId, allow: false, decision: 'deny', autoReason: reason },
    });
    pending.resolve({ behavior: 'deny', message: 'The turn was stopped.', interrupt: true });
  }

  private askQuestion(
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    const questionId = `cc-question-${toolUseId}`;
    const raw = Array.isArray(input.questions) ? input.questions : [];
    const questions: QuestionItem[] = raw.map((item) => {
      const q = record(item) ?? {};
      const options = Array.isArray(q.options) ? q.options : [];
      return {
        question: String(q.question ?? ''),
        ...(typeof q.header === 'string' ? { header: q.header } : {}),
        options: options.map((option) => {
          const o = record(option) ?? {};
          return {
            label: String(o.label ?? ''),
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
            ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
          };
        }),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
      };
    });
    this.emit({ type: 'question.requested', payload: { questionId, questions } });
    return this.parkQuestion(questionId, { kind: 'question', toolUseId, input }, signal);
  }

  /** The streamed input of one call, waiting up to `ms` for its stream to finish. */
  private streamedInput(toolCallId: string, ms: number): Promise<unknown> {
    if (this.streamedInputs.has(toolCallId))
      return Promise.resolve(this.streamedInputs.get(toolCallId));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.streamedWaiters.delete(toolCallId);
        resolve(undefined);
      }, ms);
      this.streamedWaiters.set(toolCallId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private async reviewPlan(
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    const questionId = `cc-question-${toolUseId}`;
    // The CLI's permission input for ExitPlanMode does not carry the plan; the model's call does.
    const streamed = record(await this.streamedInput(toolUseId, 2_000));
    const plan =
      typeof input.plan === 'string'
        ? input.plan
        : typeof streamed?.plan === 'string'
          ? streamed.plan
          : '';
    const title =
      plan
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean)
        ?.slice(0, 200) ?? 'Plan review';
    this.emit({
      type: 'question.requested',
      payload: {
        questionId,
        questions: [
          { id: PLAN_REVIEW_QUESTION_ID, header: 'Plan review', question: title, options: [] },
        ],
        review: {
          kind: 'plan',
          source: 'exit_plan_mode',
          title,
          ...(plan ? { plan } : {}),
          callId: toolUseId,
          goalObjective: plan || title,
          // S-2 A-7: no goals on this engine; the card picks the mode the plan runs in.
          choices: [...SDK_PLAN_REVIEW_CHOICES],
        },
      },
    });
    return this.parkQuestion(questionId, { kind: 'plan-review', toolUseId, input }, signal);
  }

  private parkQuestion(
    questionId: string,
    entry: Omit<PendingQuestion, 'resolve'>,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pendingQuestions.set(questionId, { ...entry, resolve });
      signal.addEventListener('abort', () => this.autoSettleQuestion(questionId), { once: true });
    });
  }

  respondQuestion(input: {
    questionId: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }): boolean {
    const pending = this.pendingQuestions.get(input.questionId);
    if (!pending) return false;
    if (pending.kind === 'plan-review') return this.respondPlanReview(input, pending);
    const answers =
      input.answers && Object.keys(input.answers).length > 0 ? input.answers : undefined;
    const response = input.response?.trim() ? input.response : undefined;
    if (!input.cancel && !answers && !response) return false;
    this.pendingQuestions.delete(input.questionId);
    if (input.cancel) {
      this.emit({
        type: 'question.resolved',
        payload: { questionId: input.questionId, outcome: 'cancelled' },
      });
      // Skip is "decide yourself", not a refusal: answer with nothing chosen.
      pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers: {} } });
      return true;
    }
    this.emit({
      type: 'question.resolved',
      payload: {
        questionId: input.questionId,
        outcome: 'answered',
        ...(answers ? { answers } : {}),
        ...(response ? { response } : {}),
      },
    });
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        ...(answers ? { answers } : {}),
        ...(response ? { response } : {}),
      },
    });
    return true;
  }

  private respondPlanReview(
    input: {
      questionId: string;
      answers?: Record<string, string>;
      response?: string;
      cancel?: boolean;
    },
    pending: PendingQuestion
  ): boolean {
    this.pendingQuestions.delete(input.questionId);
    const decision = decodePlanReviewResponse(input, SDK_PLAN_REVIEW_CHOICES);
    if (decision.kind === 'approve') {
      // Reported at once, inside Main's window for this answer (decision 169); the CLI
      // hears the approval once it is in the chosen mode (`leavePlanMode`).
      this.permissions = decision.permissions;
      this.emit({
        type: 'session.permissions',
        payload: {
          permissions: decision.permissions,
          cause: 'plan-approved',
          questionId: input.questionId,
        },
      });
      this.emit({
        type: 'question.resolved',
        payload: {
          questionId: input.questionId,
          outcome: 'answered',
          answers: { [PLAN_REVIEW_QUESTION_ID]: decision.choice },
          review: { choice: decision.choice },
        },
      });
      void this.leavePlanMode(decision.permissions, pending);
    } else if (decision.kind === 'keep-planning') {
      this.emit({
        type: 'question.resolved',
        payload: {
          questionId: input.questionId,
          outcome: 'answered',
          answers: { [PLAN_REVIEW_QUESTION_ID]: 'keep-planning' },
          response: decision.feedback,
          review: { choice: 'keep-planning' },
        },
      });
      pending.resolve({
        behavior: 'deny',
        message: `The user chose to keep planning; their feedback: ${decision.feedback}`,
      });
    } else {
      this.emit({
        type: 'question.resolved',
        payload: { questionId: input.questionId, outcome: 'cancelled' },
      });
      // The shared wording, so the tool row reads "review closed" (`planReviewRowOutcome`).
      pending.resolve({ behavior: 'deny', message: REVIEW_DISMISSED_TEXT, interrupt: true });
    }
    return true;
  }

  /**
   * S-2 A-7: the approved plan runs in the mode the card picked. The CLI hears the
   * approval only once it is in that mode: leaving plan mode otherwise puts the
   * mode before it back, Bypass permissions included (measured). A mode the CLI
   * refuses becomes Manual, said with its reason; if even that fails, the plan
   * does not run and the chat stays in plan mode.
   */
  private async leavePlanMode(
    chosen: RuntimePermissionSettings,
    pending: PendingQuestion
  ): Promise<void> {
    const q = this.query;
    // One switch for the whole sequence: no report in between is a change of the CLI's own.
    this.modeRequests += 1;
    try {
      if (q) {
        try {
          await this.trackModeSwitch(q.setPermissionMode(cliPermissionMode(chosen)), chosen);
        } catch (refusal) {
          const refusedReason = permissionModeRefused(refusal).message;
          this.log('the approved mode was refused; the plan runs in Manual', refusal);
          const manual: RuntimePermissionSettings = { mode: 'agent', gear: 'ask' };
          try {
            await this.trackModeSwitch(q.setPermissionMode('default'), manual);
          } catch (error) {
            this.log('leaving plan mode failed', error);
            const plan: RuntimePermissionSettings = { mode: 'plan', gear: 'auto' };
            this.permissions = plan;
            this.emit({
              type: 'session.permissions',
              payload: { permissions: plan, cause: 'engine', refusedReason },
            });
            pending.resolve({ behavior: 'deny', message: REVIEW_DISMISSED_TEXT, interrupt: true });
            return;
          }
          this.emit({
            type: 'session.permissions',
            payload: { permissions: manual, cause: 'engine', refusedReason },
          });
        }
      }
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } finally {
      this.modeRequests -= 1;
      this.reconcileCliMode();
    }
  }

  private autoSettleQuestion(questionId: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);
    this.emit({
      type: 'question.resolved',
      payload: { questionId, outcome: 'cancelled', stopped: true },
    });
    pending.resolve({ behavior: 'deny', message: 'The turn was stopped.', interrupt: true });
  }

  private drainPending(reason: 'aborted' | 'session_closed'): void {
    for (const permissionId of [...this.pendingPermissions.keys()])
      this.autoSettlePermission(permissionId, reason);
    for (const questionId of [...this.pendingQuestions.keys()]) this.autoSettleQuestion(questionId);
  }

  respondPreview(): boolean {
    return false;
  }

  // S-2 A-3, A-5: a switch counts once the CLI took it; a refusal fails the request and leaves
  // the mode as it was. Cards already up stay up: the CLI does not ask again under a new mode.

  setPermissions(permissions: RuntimePermissionSettings): Promise<void> {
    return this.applyPermissions(permissions);
  }

  setPermissionGear(gear: PermissionGear): Promise<void> {
    return this.applyPermissions({ ...this.permissions, gear });
  }

  setPermissionTier(tier: SessionPermissionTier): Promise<void> {
    return this.applyPermissions(migratePermissionTier(tier));
  }

  private async applyPermissions(next: RuntimePermissionSettings): Promise<void> {
    // No CLI running (a reopened chat before its first send): the next launch starts on it.
    const q = this.query;
    if (!q) {
      this.permissions = next;
      return;
    }
    // S-5 H-4: a CLI still starting runs no tool yet, so the mode is taken now and sent
    // once it is ready (`sendDeferredMode`); the last one picked meanwhile wins.
    if (!this.cliReady) {
      if (!this.deferredMode) this.modeRequests += 1;
      this.deferredMode = next;
      this.permissions = next;
      return;
    }
    // The mode PiLab holds changes only once the CLI took the new one: a call the CLI asks
    // about meanwhile is judged by the mode still in force.
    try {
      await this.trackModeSwitch(q.setPermissionMode(cliPermissionMode(next)), next);
    } catch (error) {
      this.log('setPermissionMode refused', error);
      throw permissionModeRefused(error);
    }
  }

  /**
   * S-5 H-4: the mode picked while the CLI was starting, now that it answers. A refusal
   * is the CLI keeping its own mode: PiLab takes that mode back and says why, as it does
   * for a mode the CLI changed by itself (S-2 A-6).
   */
  private async sendDeferredMode(q: Query): Promise<void> {
    const next = this.deferredMode;
    if (!next) return;
    this.deferredMode = null;
    try {
      await this.trackModeSwitch(q.setPermissionMode(cliPermissionMode(next)), next);
    } catch (error) {
      this.log('setPermissionMode refused once the CLI was ready', error);
      const kept = permissionsForCliMode(this.cliMode ?? '');
      if (kept && !this.disposed) {
        this.permissions = kept;
        this.emit({
          type: 'session.permissions',
          payload: {
            permissions: kept,
            cause: 'engine',
            refusedReason: permissionModeRefused(error).message,
          },
        });
      }
    } finally {
      this.modeRequests -= 1;
      this.reconcileCliMode();
    }
  }

  /**
   * One mode switch in flight, bounded in time; on success `requested` is what
   * PiLab holds. The CLI's reports are judged once no switch is in flight.
   */
  private async trackModeSwitch(
    request: Promise<void> | undefined,
    requested: RuntimePermissionSettings
  ): Promise<void> {
    if (!request) return;
    this.modeRequests += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout: the engine did not answer the mode switch')),
            MODE_SWITCH_TIMEOUT_MS
          );
        }),
      ]);
      this.permissions = requested;
      this.cliMode = cliPermissionMode(requested);
    } finally {
      clearTimeout(timer);
      this.modeRequests -= 1;
      this.reconcileCliMode();
    }
  }

  /** S-2 A-6: the mode the CLI reports. */
  private noteCliMode(mode: unknown): void {
    if (typeof mode !== 'string') return;
    this.cliMode = mode;
    this.reconcileCliMode();
  }

  /**
   * The CLI is in another mode than the one PiLab holds and no switch of ours is in
   * flight: it changed by itself, or refused ours. Take its mode and say so.
   */
  private reconcileCliMode(): void {
    if (this.modeRequests > 0 || this.cliMode === null || this.disposed) return;
    if (this.cliMode === cliPermissionMode(this.permissions)) return;
    const next = permissionsForCliMode(this.cliMode);
    if (!next) return;
    this.permissions = next;
    this.emit({ type: 'session.permissions', payload: { permissions: next, cause: 'engine' } });
  }

  // ---- reads ----------------------------------------------------------------------

  async history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult> {
    const stub = this.requireStub();
    const all = stub.started ? await this.readTranscript(stub.ccSessionId) : [];
    const limit = Math.min(500, Math.max(1, input.limit ?? 80));
    const offset = Math.max(0, input.offset ?? 0);
    const end = Math.max(0, all.length - offset);
    const start = Math.max(0, end - limit);
    return {
      logicalSessionId: this.options.logicalSessionId,
      sessionFile: this.stubFile,
      workspacePath: this.options.cwd,
      page: {
        messages: all.slice(start, end),
        offset,
        limit,
        totalCount: all.length,
        hasMore: start > 0,
      },
    };
  }

  /**
   * Rows of the CLI's transcript the SDK's reader leaves out, read from the file itself.
   *
   * - S-6: the rows the CLI wrote for a schedule that came due (`turnOrigin: "scheduled"`,
   *   `isMeta`): the SDK's reader drops those rows altogether (measured, 0.3.300), so the
   *   reply that follows one (`heads`: the assistant row whose parent it is) is where the
   *   turn's head goes.
   * - Decision 194: a local command's output, a `system` `local_command` row whose parent
   *   is the command's own row (`localOutputs`, by that parent; measured, 2.1.300).
   *
   * Every copy is read: a chat that entered a worktree has its file under that worktree's
   * project directory.
   */
  private transcriptExtras(ccSessionId: string): {
    rows: Set<string>;
    heads: Set<string>;
    localOutputs: Map<string, { uuid: string; text: string }>;
  } {
    const rows = new Set<string>();
    const heads = new Set<string>();
    const localOutputs = new Map<string, { uuid: string; text: string }>();
    if (!/^[A-Za-z0-9_-]+$/.test(ccSessionId)) return { rows, heads, localOutputs };
    const root = path.join(this.config.configDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      return { rows, heads, localOutputs };
    }
    for (const dir of dirs) {
      let raw: string;
      try {
        raw = readFileSync(path.join(root, dir, `${ccSessionId}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      const parsed: Array<{ uuid?: unknown; parentUuid?: unknown; type?: unknown }> = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            uuid?: unknown;
            parentUuid?: unknown;
            type?: unknown;
            subtype?: unknown;
            content?: unknown;
            turnOrigin?: unknown;
          };
          parsed.push(row);
          if (row.turnOrigin === 'scheduled' && typeof row.uuid === 'string') rows.add(row.uuid);
          if (
            row.type === 'system' &&
            row.subtype === 'local_command' &&
            typeof row.uuid === 'string' &&
            typeof row.parentUuid === 'string' &&
            typeof row.content === 'string'
          ) {
            const text = localCommandOutput(row.content);
            if (text) localOutputs.set(row.parentUuid, { uuid: row.uuid, text });
          }
        } catch {
          // a torn line
        }
      }
      for (const row of parsed) {
        if (
          row.type === 'assistant' &&
          typeof row.uuid === 'string' &&
          typeof row.parentUuid === 'string' &&
          rows.has(row.parentUuid)
        ) {
          heads.add(row.uuid);
        }
      }
    }
    return { rows, heads, localOutputs };
  }

  /** The CLI's own transcript, projected onto history messages (tool results folded into their call's message). */
  private async readTranscript(ccSessionId: string): Promise<HistoryMessage[]> {
    let entries: Awaited<ReturnType<typeof getSessionMessages>> = [];
    try {
      entries = await getSessionMessages(ccSessionId, { dir: this.options.cwd });
    } catch (error) {
      this.log('transcript read failed', error);
      return [];
    }
    const out: HistoryMessage[] = [];
    const byApiId = new Map<string, HistoryMessage>();
    const toolOwner = new Map<string, HistoryMessage>();
    // S-6: rows the CLI wrote for itself, which the SDK's reader does not mark (or drops).
    const scheduled = this.transcriptExtras(ccSessionId);
    for (const entry of entries) {
      if (entry.parent_tool_use_id) continue;
      const message = record(entry.message) ?? {};
      const content = message.content;
      if (entry.type === 'user') {
        if (Array.isArray(content) && content.some((b) => record(b)?.type === 'tool_result')) {
          for (const block of content) {
            const b = record(block);
            if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
            const owner = toolOwner.get(b.tool_use_id);
            // A refusal of the CLI's own reads as it did live: never its sentence (A-18).
            const raw = textOf(b.content);
            const text = b.is_error === true ? cliRefusalRewrite(raw) : raw;
            owner?.blocks.push({
              type: 'tool_result',
              id: `${b.tool_use_id}-result`,
              toolCallId: b.tool_use_id,
              ok: b.is_error !== true,
              output: text,
              ...(b.is_error === true ? { error: text } : {}),
            });
          }
          continue;
        }
        const text = textOf(content);
        const trimmed = text.trim();
        // Decision 194: a command reads as the user typed it, and a local command's output
        // as its reply. The window's `/compact` has its own row (the summary), as live.
        const command = commandRowLine(trimmed);
        if (command) {
          if (SDK_WINDOW_OWNED_COMMANDS.has(command.name)) continue;
          out.push({
            id: `h:${entry.uuid}`,
            entryId: entry.uuid,
            role: 'user',
            blocks: [{ type: 'text', id: `${entry.uuid}-text`, text: command.line }],
          });
          const output = scheduled.localOutputs.get(entry.uuid);
          if (output) out.push(localReply(output.uuid, output.text));
          continue;
        }
        // An older CLI wrote a local command's output as a user row.
        const output = localCommandOutput(trimmed);
        if (output) {
          out.push(localReply(entry.uuid, output));
          continue;
        }
        // The CLI's own bookkeeping rows: an interrupt marker, a local command's caveat.
        if (!trimmed || CLI_MARKER_TEXT.test(trimmed)) continue;
        // S-6: a turn the CLI started by itself reads as it did live, as an engine turn's
        // head, never as something the user typed: a schedule that came due, or a
        // background task's (or subagent's) notification.
        const origin: TurnOrigin | undefined = scheduled.rows.has(entry.uuid)
          ? { kind: 'scheduled' }
          : trimmed.startsWith('<task-notification>')
            ? /<summary>Agent /.test(trimmed)
              ? { kind: 'subagent' }
              : { kind: 'job' }
            : undefined;
        if (origin) {
          out.push({
            id: `h:${entry.uuid}`,
            entryId: entry.uuid,
            role: 'user',
            origin,
            blocks: [],
          });
          continue;
        }
        // A compaction's summary reads as the session's own note, not as something the user typed.
        const role = trimmed.startsWith(COMPACT_SUMMARY_PREFIX) ? 'system' : 'user';
        out.push({
          id: `h:${entry.uuid}`,
          entryId: entry.uuid,
          role,
          // Decision 206: a message sent from here keeps the uuid it went to the CLI with
          // (a Ctrl+Enter one too: the SDK's reader names it by its `source_uuid`).
          ...(role === 'user' ? { transcriptId: entry.uuid } : {}),
          blocks: [{ type: 'text', id: `${entry.uuid}-text`, text }],
        });
        continue;
      }
      if (entry.type !== 'assistant') continue;
      // The reply to a schedule that came due, whose own row the SDK dropped: its head first.
      if (scheduled.heads.has(entry.uuid)) {
        out.push({
          id: `h:${entry.uuid}-scheduled`,
          entryId: entry.uuid,
          role: 'user',
          origin: { kind: 'scheduled' },
          blocks: [],
        });
      }
      const apiId = typeof message.id === 'string' ? message.id : entry.uuid;
      let target = byApiId.get(apiId);
      if (!target) {
        target = {
          id: `h:${entry.uuid}`,
          entryId: entry.uuid,
          role: 'assistant',
          // Decision 206: the API message id its live step carried.
          ...(typeof message.id === 'string' ? { transcriptId: message.id } : {}),
          ...(typeof message.model === 'string' ? { model: message.model } : {}),
          blocks: [],
        };
        byApiId.set(apiId, target);
        out.push(target);
      }
      if (!Array.isArray(content)) continue;
      for (const [i, block] of content.entries()) {
        const b = record(block);
        if (!b) continue;
        const id = `${entry.uuid}-${i}`;
        let projected: HistoryBlock | null = null;
        if (b.type === 'text' && typeof b.text === 'string')
          projected = { type: 'text', id, text: b.text };
        else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          projected = { type: 'thinking', id, text: b.thinking };
        } else if (b.type === 'tool_use' && typeof b.id === 'string') {
          projected = {
            type: 'tool_call',
            id: b.id,
            toolCallId: b.id,
            name: String(b.name),
            input: b.input,
          };
          toolOwner.set(b.id, target);
        }
        if (projected) target.blocks.push(projected);
      }
    }
    return out;
  }

  async tree(): Promise<WorkerTreeResult> {
    return {
      snapshot: {
        logicalSessionId: this.options.logicalSessionId,
        sessionFile: this.stubFile,
        workspacePath: this.options.cwd,
        leaf: { activeEntryId: null, fileTailEntryId: null },
        nodes: [],
        totalNodes: 0,
        returnedNodes: 0,
        truncated: false,
      },
    } as WorkerTreeResult;
  }

  /**
   * Decision 194: the CLI's own list (`slashCommands.ts`), with descriptions, before any
   * message. A reopened chat starts its CLI on the first send; the menu starts it now, as
   * that send would (the cold start is then behind the user when they send).
   */
  async commands(): Promise<WorkerCommandsResult> {
    if (this.disposed) return { commands: [], truncated: false };
    if (!this.cliCommands && this.bootstrapResult) {
      const q = this.ensureQuery();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const init = await Promise.race([
          q.initializationResult(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('timeout: the CLI did not list its commands')),
              COMMANDS_TIMEOUT_MS
            );
          }),
        ]);
        if (this.query === q && !this.cliCommands) {
          this.cliCommands = cliSlashCommands(
            (init as { commands?: unknown } | undefined)?.commands
          );
        }
      } catch (error) {
        this.log('slash commands unavailable', error);
      } finally {
        clearTimeout(timer);
      }
    }
    return sdkSlashCommandRows(this.cliCommands ?? [], this.terminalCommands);
  }

  async panels(): Promise<WorkerPanelsResult> {
    return {
      projections: [
        { key: 'goalActivation', view: null },
        { key: 'jobs', view: this.board.jobs() },
        { key: 'subagentCatalog', view: this.board.subagentCatalog() },
      ],
    };
  }

  /** `/compact` is the CLI's own command: sent as a message, settled by its result. */
  async compact(input: { instructions?: string }): Promise<WorkerCompactResult> {
    if (this.turn || this.compacting) {
      throw new BridgeSessionError('WORKER_SESSION_BUSY', 'A turn is already running', true);
    }
    this.ensureQuery();
    const done = new Promise<WorkerCompactResult>((resolve, reject) => {
      this.compacting = { resolve, reject };
    });
    const instructions = input.instructions?.trim() || DEFAULT_COMPACT_INSTRUCTIONS;
    this.input?.push({
      type: 'user',
      message: { role: 'user', content: `/compact ${instructions}` },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    return done;
  }

  cancelCompact(): WorkerCompactCancelResult {
    return { cancelled: false };
  }

  async command(): Promise<WorkerCommandResult> {
    return { ok: false, error: 'Not available on the Claude SDK engine' };
  }

  /** S-6 feedback 4: the jobs window's Stop, through the CLI's own `stop_task`. */
  async killJob(input: WorkerJobKillPayload): Promise<WorkerJobKillResult> {
    if (!this.board.isRunning(input.jobId)) return { outcome: 'already-finished' };
    const q = this.query as (Query & { stopTask?: (taskId: string) => Promise<void> }) | null;
    if (!q?.stopTask) return { outcome: 'already-finished' };
    if (this.board.markStopping(input.jobId)) {
      this.applyBoard({ jobs: true, catalog: false, activity: [] });
    }
    // The task's MSYS leftovers are ended when its notification says it stopped: its
    // shell has to be known before the CLI ends it.
    await this.shellLookup;
    await q
      .stopTask(input.jobId)
      .catch((error) => this.log(`stop task ${input.jobId} failed`, error));
    return { outcome: 'requested' };
  }

  /**
   * A background command started: note its Git Bash's MSYS process group (Windows). Its
   * shell is the Git Bash under the CLI, owned by no other task, created closest to when
   * the task started (the CLI reports a task once its shell runs); one task at a time,
   * in start order.
   */
  private noteTaskShell(taskId: string): void {
    if (process.platform !== 'win32' || !this.config.gitBashPath) return;
    const gitBash = this.config.gitBashPath;
    const startedAt = this.board.startedAt(taskId) ?? Date.now();
    this.log(`task ${taskId}: looking for its Git Bash`);
    const lookup = async () => {
      if (!this.board.isRunning(taskId)) {
        this.log(`task ${taskId}: ended before its Git Bash was looked for`);
        return;
      }
      const table = await sampleProcesses({ log: (m) => this.log(m) });
      const msys = await msysProcessTable(gitBash, STOP_SAMPLE_WAIT_MS);
      const owned = new Set([...this.taskGroups.values()].map((group) => group.shell));
      // Two bash.exe appear per command, a few ms apart; only the one Git Bash's own table
      // lists runs the command (its MSYS group is the one to end).
      const listed = new Map(msys.map((row) => [row.winpid, row] as const));
      const candidates = descendantsOf(process.pid, table)
        .filter(
          (row) => /^bash\.exe$/i.test(row.name) && !owned.has(row.pid) && listed.has(row.pid)
        )
        .sort((a, b) => Math.abs(a.start - startedAt) - Math.abs(b.start - startedAt));
      this.log(
        `task ${taskId} (started ${startedAt}): shells ${candidates.map((row) => `#${row.pid}@${Math.round(row.start)}`).join(' ') || '(none)'}`
      );
      const shell = candidates[0];
      const root = shell ? listed.get(shell.pid) : undefined;
      if (!shell || !root) return;
      this.taskGroups.set(taskId, { shell: shell.pid, pgid: root.pgid });
      this.log(`task ${taskId}: Git Bash #${shell.pid}, MSYS group ${root.pgid}`);
    };
    this.shellLookup = this.shellLookup
      .then(lookup)
      .catch((error) => this.log(`task ${taskId}: no shell group`, error));
  }

  /** A task ended: if it was stopped, end what is left of its MSYS group. */
  private settleTaskShell(taskId: string, status: unknown): void {
    const group = this.taskGroups.get(taskId);
    if (!group) return;
    this.taskGroups.delete(taskId);
    if (status !== 'stopped' || !this.config.gitBashPath) return;
    const gitBash = this.config.gitBashPath;
    setTimeout(() => {
      void (async () => {
        const left = (await msysProcessTable(gitBash, STOP_SAMPLE_WAIT_MS)).filter(
          (row) => row.pgid === group.pgid && row.winpid !== group.shell
        );
        const killed = left.filter((row) => killProcess(row.winpid));
        if (killed.length > 0) {
          this.log(
            `task ${taskId} stopped: ended ${killed.length} process(es) of its group: ${killed.map((row) => `${row.command}#${row.winpid}`).join(', ')}`
          );
        }
      })().catch((error) => this.log(`task ${taskId}: reap failed`, error));
    }, 1_000);
  }

  /**
   * S-6 feedback 4: a job's output, read from the file the CLI writes it to
   * (`<tmp>/claude/<cwd dir>/<session id>/tasks/<task id>.output`), named by its
   * notification once it ended and found by its id while it runs.
   */
  /**
   * Layout 5f (ui-cohesion ruling L6): the CLI's own side question — what its `/btw`
   * sends (the `side_question` control request, `Query.askSideQuestion`, untyped in
   * 0.3.300). The CLI reads the live conversation, runs no tool and writes nothing to
   * the transcript. A reopened chat starts its CLI first, as a send does, so the
   * question sees the resumed conversation. Allowed while a turn runs.
   */
  async sideQuestion(
    input: WorkerSideQuestionPayload,
    signal: AbortSignal
  ): Promise<WorkerSideQuestionResult> {
    const cancelled = () =>
      new BridgeSessionError(WORKER_SIDE_QUESTION_CANCELLED, 'The side question was cancelled');
    if (signal.aborted) throw cancelled();
    if (this.disposed) {
      throw new BridgeSessionError('WORKER_DISPOSED', 'The conversation was closed');
    }
    this.requireStub();
    const q = this.ensureQuery() as Query & {
      askSideQuestion?: (
        question: string,
        options?: {
          history?: Array<{ question: string; response: string }>;
          signal?: AbortSignal;
        }
      ) => Promise<{ response: string; synthetic: boolean } | null>;
    };
    if (typeof q.askSideQuestion !== 'function') {
      throw new BridgeSessionError(
        WORKER_SIDE_QUESTION_UNAVAILABLE,
        'This engine version cannot answer side questions'
      );
    }
    let answer: { response: string; synthetic: boolean } | null;
    try {
      answer = await q.askSideQuestion(input.question, {
        ...(input.history?.length
          ? {
              history: input.history.map((turn) => ({
                question: turn.question,
                response: turn.answer,
              })),
            }
          : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      throw error;
    }
    if (signal.aborted) throw cancelled();
    // `synthetic`: the CLI's own "no answer" sentence stands in for one.
    if (!answer || answer.synthetic || !answer.response.trim()) return { text: null };
    return { text: answer.response };
  }

  async readJob(input: WorkerJobReadPayload): Promise<WorkerJobReadResult> {
    const empty: WorkerJobReadResult = {
      text: '',
      from: 0,
      next: 0,
      omittedBytes: 0,
      lossy: false,
    };
    const maxBytes = Math.max(1, input.maxBytes ?? WORKER_JOB_READ_DEFAULT_BYTES);
    // A subagent's output file stays empty on Windows (measured, 2.1.300): what it said
    // is in its own transcript.
    if (this.board.kindOf(input.jobId) === 'subagent') {
      const transcript = this.findSubagentTranscript(input.jobId);
      if (!transcript) return empty;
      const bytes = Buffer.from(subagentText(transcript), 'utf8');
      return windowOf(bytes, input.from, maxBytes, transcript);
    }
    const file = this.board.outputFile(input.jobId) ?? this.findTaskOutput(input.jobId);
    if (!file) return empty;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return empty;
    }
    const asked = Math.min(Math.max(0, input.from ?? Math.max(0, size - maxBytes)), size);
    const start = Math.max(asked, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      const fd = openSync(file, 'r');
      try {
        readSync(fd, buffer, 0, length, start);
      } finally {
        closeSync(fd);
      }
    }
    return {
      text: buffer.toString('utf8'),
      from: start,
      next: size,
      omittedBytes: input.from === undefined ? start : start - asked,
      lossy: false,
      spillPaths: [file],
    };
  }

  /** `<configDir>/projects/<cwd dir>/<session id>/subagents/agent-<task id>.jsonl`. */
  private findSubagentTranscript(taskId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return undefined;
    const ccSessionId = this.stub?.ccSessionId;
    if (!ccSessionId) return undefined;
    const root = path.join(this.config.configDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, ccSessionId, 'subagents', `agent-${taskId}.jsonl`);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not this directory
      }
    }
    return undefined;
  }

  /** A running task's output file: the CLI names it only when the task ends. */
  private findTaskOutput(taskId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return undefined;
    const ccSessionId = this.stub?.ccSessionId;
    if (!ccSessionId) return undefined;
    const root = path.join(tmpdir(), 'claude');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, ccSessionId, 'tasks', `${taskId}.output`);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not this directory
      }
    }
    return undefined;
  }

  async interruptSubagent(): Promise<WorkerSubagentInterruptResult> {
    return { interrupted: false };
  }

  /**
   * Decision 203: a subagent's own conversation, from the CLI's transcript of it
   * under this session's directory (so only this session's subagents are found).
   */
  async subagentHistory(input: WorkerSubagentHistoryPayload): Promise<WorkerSubagentHistoryResult> {
    const file = this.findSubagentTranscript(input.childId);
    if (!file) return { messages: [], truncated: false };
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      this.log('subagent transcript unreadable', error);
    }
    return subagentHistoryOf(projectSubagentTranscript(raw));
  }

  /**
   * Decision 203: the CLI's own Ctrl+B for one call (`background_tasks` with
   * its `tool_use_id`): a running foreground command or subagent goes on as a
   * background task and the call returns at once. The CLI answers whether it
   * found the call (`backgrounded`): one that ended, or that it has not
   * registered as a task yet (a command's first moment), is not moved.
   */
  async backgroundTool(input: WorkerToolBackgroundPayload): Promise<WorkerToolBackgroundResult> {
    const request = (
      this.query as unknown as {
        request?: (
          body: Record<string, unknown>
        ) => Promise<{ response?: Record<string, unknown> } | undefined>;
      } | null
    )?.request;
    if (!this.turn || !request) return { backgrounded: false };
    try {
      const answer = await request.call(this.query, {
        subtype: 'background_tasks',
        tool_use_id: input.toolCallId,
      });
      return { backgrounded: answer?.response?.backgrounded === true };
    } catch (error) {
      this.log(`background ${input.toolCallId} refused`, error);
      return { backgrounded: false };
    }
  }

  async rewind(): Promise<WorkerRewindResult> {
    throw unsupported('worker.rewind');
  }

  async fork(): Promise<WorkerForkResult> {
    throw unsupported('worker.fork');
  }

  async discardFork(): Promise<WorkerDiscardForkResult> {
    return { discarded: false };
  }

  async acceptFork(): Promise<WorkerAcceptForkResult> {
    return { accepted: false };
  }

  private requireStub(): ClaudeSdkSessionStub {
    if (!this.stub)
      throw new BridgeSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    return this.stub;
  }
}

function unsupported(method: string): BridgeSessionError {
  return new BridgeSessionError(
    'WORKER_METHOD_UNSUPPORTED',
    `${method} is not available on the Claude SDK engine`
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The card body the permission card reads: our own summary, not the raw arguments. */
function describeCall(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string
): {
  kind: PermissionRequestKind;
  action?: PermissionRequestAction;
  input: Record<string, unknown>;
  detail?: PermissionDetail;
} {
  const path =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.notebook_path === 'string'
        ? input.notebook_path
        : undefined;
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command ?? '');
    return {
      kind: 'exec',
      action: 'run_command',
      input: { command, workspace },
      detail: { kind: 'exec', command, cwd: workspace },
    };
  }
  if (FILE_CHANGE_TOOLS.has(toolName) && path) {
    const content =
      typeof input.content === 'string'
        ? input.content
        : typeof input.new_string === 'string'
          ? input.new_string
          : undefined;
    return {
      kind: 'file_change',
      action: toolName === 'Write' ? 'write_file' : 'edit_file',
      input: {
        path,
        ...(content !== undefined ? { content, contentLabel: 'Content' } : {}),
        workspace,
      },
      detail: {
        kind: 'file_change',
        changes: [{ path, change: toolName === 'Write' ? 'add' : 'update' }],
      },
    };
  }
  if (toolName === 'Read' && path) {
    return { kind: 'tool', action: 'read_file', input: { path, workspace } };
  }
  return { kind: 'tool', input: { ...input, workspace } };
}
