/**
 * Issue #26 item 1: the hover actions under a user message — copy, edit &
 * resend, fork from here.
 *
 * Nothing here is new machinery. Edit & resend is the session tree's rewind to
 * a prompt (`chat:rewindSession`), which hands the prompt back as
 * `editorText`, offered to this chat's composer through `composerDrafts`'s
 * `offerText` exactly as `SessionTreeDialog` does. Fork is that dialog's fork
 * (`chat:forkSession` + `materializeForkedChatSession`). This module is the
 * pure half: which actions a message offers, and which tree entry it is.
 */
import type { SessionTreeNode } from '@shared/types/sessionHistory';
import type { ChatMessage } from '@/stores/chatSessions';
import {
  isLegacyMigrationRequiredError,
  LEGACY_MIGRATION_OPERATION_FAILED,
} from './sessionIndex/legacyMigration';
import {
  isSessionNotRunningError,
  SESSION_START_KEYS,
  SESSION_STOPPED_BEFORE_RUN,
} from './sessionStart';

export interface UserMessageActionInput {
  /** `ChatSession.engine`: `'claude-sdk'`, or undefined for DSH. */
  engine: string | undefined;
  /** The chat has a durable session on disk (`runtimeIdentity`) — a tree to act on. */
  hasDurableSession: boolean;
  /** `statusForNextTurn(session) === 'idle'`: a rewind or fork is refused mid-run. */
  idle: boolean;
  /** The message is still being sent or awaits delivery: nothing to act on yet. */
  pending: boolean;
}

export interface UserMessageActionSet {
  copy: boolean;
  edit: boolean;
  fork: boolean;
}

/**
 * Copy is always there. Edit and fork need the session tree, which the Claude
 * SDK engine does not offer (its runtime answers `worker.rewind` /
 * `worker.fork` with "unsupported"), so they are hidden for that engine, and
 * for a message still on its way. Mid-run they stay visible but disabled
 * (`idle`), as the tree dialog's buttons do.
 */
export function userMessageActions(input: UserMessageActionInput): UserMessageActionSet {
  const tree = input.engine !== 'claude-sdk' && input.hasDurableSession && !input.pending;
  return { copy: true, edit: tree, fork: tree };
}

/** What Copy puts on the clipboard: the prompt as typed, paragraphs kept. */
export function userMessageCopyText(message: Pick<ChatMessage, 'blocks'>): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n');
}

const PREVIEW_MAX = 96;

/** The tree's own preview of a message (`dshHistory/tree.ts` `previewOf`), to match by. */
export function promptTreePreview(message: Pick<ChatMessage, 'blocks'>): string {
  const text = userMessageCopyText(message).replace(/\s+/g, ' ').trim();
  return text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX - 1)}…`;
}

function isPrompt(message: ChatMessage): boolean {
  return message.role === 'user' && !message.origin;
}

/**
 * The tree entry a user message stands for.
 *
 * A replayed message carries it (`entryId`). One sent in this window carries
 * only the live echo's id, so it is found in the tree instead: among the
 * prompts on the active path with the same preview, the one at the same place
 * counted from the END — the timeline may hold only the latest page, while the
 * tree window always keeps the leaf. `null` when the tree does not hold it.
 */
export function resolvePromptEntryId(
  target: ChatMessage,
  timeline: readonly ChatMessage[],
  nodes: readonly SessionTreeNode[]
): string | null {
  if (target.entryId) return target.entryId;
  const preview = promptTreePreview(target);
  const twins = timeline.filter(
    (message) => isPrompt(message) && promptTreePreview(message) === preview
  );
  const position = twins.findIndex((message) => message.id === target.id);
  if (position < 0) return null;
  const fromEnd = twins.length - 1 - position;
  const candidates = nodes.filter(
    (node) => node.active && node.role === 'user' && (node.preview ?? '') === preview
  );
  return candidates[candidates.length - 1 - fromEnd]?.id ?? null;
}

/**
 * dsh-rebase P1-4b: a DSH rewind retires the agent a background job runs
 * under, so the worker refuses while one runs.
 */
const REWIND_JOBS_RUNNING = 'WORKER_REWIND_JOBS_RUNNING';

/** The keys of the failures this module translates (the rest pass through as sentences). */
const TRANSLATED: ReadonlySet<string> = new Set(SESSION_START_KEYS);

/** A failed action's description: a dictionary key (`translated`) or the sentence it came with. */
export function userMessageActionFailure(cause: unknown): { text: string; translated: boolean } {
  if (isLegacyMigrationRequiredError(cause)) {
    return { text: LEGACY_MIGRATION_OPERATION_FAILED, translated: true };
  }
  if (isSessionNotRunningError(cause))
    return { text: SESSION_STOPPED_BEFORE_RUN, translated: true };
  const text = cause instanceof Error ? cause.message : String(cause);
  if (text.includes(REWIND_JOBS_RUNNING)) {
    return {
      text: 'A background task of this session is still running. Wait for it to finish, or stop it, before rewinding.',
      translated: true,
    };
  }
  return {
    text,
    translated:
      TRANSLATED.has(text) || text === PROMPT_ENTRY_NOT_FOUND || text === FORK_NOT_MATERIALIZED,
  };
}

/** The IPC and store effects one action needs, injected so the flow is testable. */
export interface PromptActionDeps {
  /** `runWithSessionStarted` around one operation; throws a dictionary key when it cannot start. */
  afterStart: <T>(operation: () => Promise<T>) => Promise<T>;
  getSessionTree: (sessionId: string) => Promise<{ snapshot: { nodes: SessionTreeNode[] } }>;
  rewindSession: (sessionId: string, entryId: string) => Promise<{ editorText?: string }>;
  forkSession: (sessionId: string, entryId: string) => Promise<{ session: unknown }>;
  /** `resetSessionScopedRendererState`, after a rewind moved the active path. */
  resetSession: (sessionId: string) => void;
  /** `composerDrafts.offerText`: merged after whatever the composer already holds. */
  offerText: (sessionId: string, text: string) => void;
  focusComposer: (sessionId: string) => void;
  /** `materializeForkedChatSession`; false when the fork cannot be shown here. */
  materializeFork: (session: unknown) => boolean;
}

/** Thrown when the tree does not hold the message (it cannot be rewound to or forked from). */
export const PROMPT_ENTRY_NOT_FOUND =
  'This message is not in the session tree yet. Try again once the reply has finished.';
export const FORK_NOT_MATERIALIZED =
  'Fork was created, but its workspace could not be materialized in this window';

async function entryIdFor(
  deps: PromptActionDeps,
  sessionId: string,
  message: ChatMessage,
  timeline: readonly ChatMessage[]
): Promise<string> {
  if (message.entryId) return message.entryId;
  const tree = await deps.afterStart(() => deps.getSessionTree(sessionId));
  const entryId = resolvePromptEntryId(message, timeline, tree.snapshot.nodes);
  if (!entryId) throw new Error(PROMPT_ENTRY_NOT_FOUND);
  return entryId;
}

/** Edit & resend: rewind to the prompt, its text back into this chat's composer. */
export async function runEditAndResend(
  deps: PromptActionDeps,
  sessionId: string,
  message: ChatMessage,
  timeline: readonly ChatMessage[]
): Promise<void> {
  const entryId = await entryIdFor(deps, sessionId, message, timeline);
  const result = await deps.afterStart(() => deps.rewindSession(sessionId, entryId));
  deps.resetSession(sessionId);
  // The worker's own text is the authority; the bubble's is the fallback.
  const text = result.editorText ?? userMessageCopyText(message);
  if (text) deps.offerText(sessionId, text);
  deps.focusComposer(sessionId);
}

/** Fork from here: a new chat that inherits the conversation through this prompt. */
export async function runForkFromPrompt(
  deps: PromptActionDeps,
  sessionId: string,
  message: ChatMessage,
  timeline: readonly ChatMessage[]
): Promise<void> {
  const entryId = await entryIdFor(deps, sessionId, message, timeline);
  const result = await deps.afterStart(() => deps.forkSession(sessionId, entryId));
  if (!deps.materializeFork(result.session)) throw new Error(FORK_NOT_MATERIALIZED);
}
