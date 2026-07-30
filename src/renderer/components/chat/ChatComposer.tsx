import type { FileSearchResult } from '@shared/types/search';
import {
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  TriangleAlert,
  X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { classifyAssistantProgress } from './assistantProgress';
import { largeAttachmentHint, sendTimeoutMs } from './attachmentLimits';
import {
  type AttachmentDraft,
  composerSendingLine,
  type SendPhase,
  SLOW_WAIT_HINT_SECONDS,
  shouldRenderThumbnail,
  toAttachmentChip,
  totalAttachmentBytes,
  toWireAttachments,
} from './attachments';
import { ComposerRoundButton } from './ComposerRoundButton';
import { ComposerTargetBar } from './ComposerTargetBar';
import { resolveActiveTarget } from './composerTarget';
import { EffortSelect } from './EffortSelect';
import { toWireEffort } from './efforts';
import { extractMentionQuery, parseMentionChips, replaceMention } from './fileMention';
import { consumeForkDraftCarry } from './forkDraftCarry';
import { ModelSelect } from './ModelSelect';
import {
  composerCardClass,
  composerPlaceholder,
  composerTextareaClass,
  type MiddleColumnMode,
  mentionPopupPlacementClass,
  shouldShowStatusLine,
} from './middleColumnLayout';
import { defaultModelId } from './models';
import { ReadingColumn } from './ReadingColumn';
import { decideSendPreamble } from './sendPreamble';
import { useComposerAttachments } from './useComposerAttachments';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

interface ChatComposerProps {
  /** T-28: two-state host mode — drives the card shape/layout branch below (§3.4). */
  mode: MiddleColumnMode;
  disabled?: boolean;
  /** Opens the shared AddRepositoryDialog (owned by App) — see ComposerTargetBar. */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
  /** T-28: fires once runSend's guards pass, before the send starts — feeds the sticky `sendAttempted` latch in ChatWorkspace. */
  onSendStart?: () => void;
}

/** T-07③: popup page size. Kept next to the truncation hint that reports it. */
const MENTION_PAGE_SIZE = 10;

function isStoppable(status: string | undefined): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatRuntimeEvent(event: { type: string; payload?: unknown }): string {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as { code?: string; message?: string; error?: string; status?: string })
      : null;
  const code = payload?.code;
  const message = payload?.message ?? payload?.error;
  const status = payload?.status;
  if (code || message) {
    return `${event.type}(${code ?? ''}${code && message ? ': ' : ''}${message ?? ''})`;
  }
  if (status) {
    return `${event.type}(${status})`;
  }
  return event.type;
}

interface AttachmentChipProps {
  draft: AttachmentDraft;
  sending: boolean;
  onRemove: (id: string) => void;
}

/**
 * One attachment chip.
 *
 * Memoised on purpose: the send status line ticks once a second for up to
 * SEND_TIMEOUT_CEILING_MS, and re-deriving `data:${mediaType};base64,${data}`
 * on every one of those renders would flatten a multi-MB string per tick for
 * the whole wait. With stable props React skips this subtree entirely.
 */
const AttachmentChip = memo(function AttachmentChip({
  draft,
  sending,
  onRemove,
}: AttachmentChipProps) {
  const chip = toAttachmentChip(draft);
  // The clipboard is invisible — a thumbnail is the only way to confirm what
  // was actually pasted. Large images fall back to the icon: a data: URI is
  // decoded at natural size before being rastered into 16 CSS pixels.
  const previewUrl = useMemo(
    () => (shouldRenderThumbnail(draft) ? `data:${draft.mediaType};base64,${draft.data}` : null),
    [draft]
  );

  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-xs border border-border bg-muted/50 pr-0.5 pl-1.5 text-xs text-foreground',
        sending && 'pointer-events-none opacity-64'
      )}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="size-4 shrink-0 rounded-xs object-cover" />
      ) : draft.kind === 'image' ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={chip.title}>
        {chip.label}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{chip.sizeLabel}</span>
      <button
        type="button"
        onClick={() => onRemove(draft.id)}
        disabled={sending}
        aria-label={`Remove ${chip.title}`}
        className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
      >
        <X className="size-3" />
      </button>
    </span>
  );
});

/** Wait until predicate, or timeout. Returns false on timeout. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

export function ChatComposer({ mode, disabled, onAddRepository, onSendStart }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  // T-18: an object rather than a plain string because an attachment-only turn
  // fails with text '' — `retryable !== null` is then the only honest "the last
  // turn failed" signal, and Boolean(text) would silently hide Retry.
  const [retryable, setRetryable] = useState<{ text: string } | null>(null);
  /** T-18: seconds since the current send phase started — the "still alive" signal. */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /** T-18: wait budget of the in-flight send, so the status text cannot lie. */
  const [sendBudgetMs, setSendBudgetMs] = useState(sendTimeoutMs(0));
  /** T-18: handshake vs awaiting — "Sent 152 KB" must not appear before send. */
  const [sendPhase, setSendPhase] = useState<SendPhase>('handshake');
  const phaseStartedAtRef = useRef(0);
  // Synchronous re-entry latch: `canSend` is a render-closure constant and
  // setSending is async, so two calls in one tick would both pass the checks.
  const inFlightRef = useRef(false);
  // T-07 @ 文件引用：popup 态、搜索结果、选中索引、IME 合成态。delayed 焦点
  // 恢复通过 setTimeout 在 React 提交后再 setSelectionRange。
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<FileSearchResult[]>([]);
  /** T-07③ pre-truncation match count, so the popup can say "10 / 304". */
  const [mentionTotal, setMentionTotal] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const lastError = useChatSessionsStore((state) => state.lastError);
  const activeMessages = useChatSessionsStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );

  // T-27: shared with the Composer target bar (§2.6) — this is the same
  // production derivation the target bar's plan/apply flow lands through,
  // not a parallel copy of the lookup logic.
  const {
    session: activeSession,
    workspace: activeWorkspace,
    cwd,
  } = resolveActiveTarget({ activeSessionId, sessions, workspaces });
  const mentionChips = useMemo(() => parseMentionChips(value), [value]);
  const mentionOpen = mentionQuery !== null && mentionResults.length > 0;
  const busy = isStoppable(activeSession?.status);
  // A Send in flight must also be abortable: the SDK stream can hang (e.g.
  // gateway revoked key) without ever flipping session.status to running, and
  // the user needs Stop during the 45s wait, not just when store says busy.
  const canStop = busy || sending;
  // `cwd` (resolveActiveTarget's derived value, not `activeWorkspace?.path`
  // directly): it already folds "no workspace" and "workspace present but
  // not targetable (demo placeholder's empty path)" into a single null, so
  // every send-gate check below reads that one value instead of re-deriving
  // "is this path usable" ad hoc.
  const canSend = Boolean(activeSessionId && cwd && !disabled && !canStop);
  const { getSessionModel } = useSessionModel();
  const { getSessionEffort } = useSessionEffort();
  // T-18 paste attachments. Reads/encoding stay in the hook; every threshold
  // and format decision is a pure function under __tests__.
  const attachments = useComposerAttachments({ disabled: Boolean(disabled) || busy || sending });
  const { clearDrafts: clearAttachmentDrafts, dismissNotice: dismissAttachmentNotice } =
    attachments;

  // Drafts belong to the session they were pasted into. The Composer is mounted
  // once with no key, so without this a screenshot pasted in session A would
  // ride along with the next message sent from session B — real image tokens
  // and unrelated visual context, invisible in the timeline either way. The
  // failure state is scoped the same way: session A's Retry must not appear
  // over session B.
  useEffect(() => {
    // T-27 fix: a fork (useComposerTarget's selectTarget / applyPendingTarget
    // marking `markForkDraftCarry`) intentionally carries the composer's
    // in-flight state onto the new session — the textarea `value` state is
    // never touched here either way, so text + attachments land together on
    // the forked session instead of being wiped by the switch below.
    if (activeSessionId && consumeForkDraftCarry(activeSessionId)) return;
    clearAttachmentDrafts();
    dismissAttachmentNotice();
    setRetryable(null);
  }, [activeSessionId, clearAttachmentDrafts, dismissAttachmentNotice]);

  const statusHint = !activeSessionId
    ? 'No session selected — pick Live Agent Host in the left nav (or click New).'
    : !activeWorkspace
      ? 'Active session has no workspace — re-open a repository and refresh.'
      : !cwd
        ? 'No repository registered — launch with --open-path=<repo> (or add a repository) first.'
        : lastError
          ? `Error: ${lastError}`
          : sending
            ? 'Starting Agent Host / sending…'
            : busy
              ? 'Agent Host running — use Stop to abort'
              : `Ready · cwd: ${cwd}`;

  const handleSend = async () => {
    const trimmed = value.trim();
    // Attachment-only sends are legal (the Host only rejects "no text AND no
    // attachments"), so an empty textarea is not a reason to bail.
    if (!trimmed && attachments.drafts.length === 0) return;
    if (!canSend || !activeSessionId || !activeWorkspace || attachments.reading > 0) {
      return;
    }
    await runSend(trimmed, attachments.drafts);
    setValue('');
  };

  // T-07 @ 文件搜索：150ms 防抖，cwd 缺失或 mention 关闭时清空结果。
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionResults([]);
      setMentionTotal(0);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI.search
        .files({ rootPath: cwd, query: mentionQuery, maxResults: MENTION_PAGE_SIZE })
        .then((page) => {
          setMentionResults(page.items);
          setMentionTotal(page.total);
        })
        .catch(() => {
          setMentionResults([]);
          setMentionTotal(0);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionQuery, cwd]);

  const handleContentChange = (next: string) => {
    setValue(next);
    if (composingRef.current || !cwd) {
      setMentionQuery(null);
      return;
    }
    // setTimeout 读取 React 提交后的 selectionStart（与 EnhancedInput 同套路）。
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) {
        setMentionQuery(null);
        return;
      }
      setMentionQuery(extractMentionQuery(next, ta.selectionStart));
      setMentionIndex(0);
    }, 0);
  };

  const insertMention = (item: FileSearchResult) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const out = replaceMention(value, cursor, item);
    if (!out) return;
    setValue(out.text);
    setMentionQuery(null);
    setMentionResults([]);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(out.cursor, out.cursor);
    }, 0);
  };

  const lastUserPrompt = activeSessionId
    ? [...(activeMessages ?? [])].reverse().find((message) => message.role === 'user')
    : undefined;
  // Retry is offered when the last turn ended badly: explicit session.failed
  // (Host emitted it) OR the Composer fallback set `retryable` because the
  // SDK stream ended with no assistant progress (e.g. gateway revoked key —
  // Host lands on idle/stopped, not failed, so status check alone misses it).
  const retryText =
    retryable?.text ??
    (activeSession?.status === 'failed'
      ? lastUserPrompt?.blocks.find((block) => block.type === 'text' && block.text)?.text
      : undefined);
  // Retry is a failure affordance, never a second Send. Gating it on "something
  // exists to resend" alone made a Retry button appear on a healthy session the
  // moment a screenshot was pasted — and clicking it would have sent the image
  // with an empty text field, then wiped the sentence the user had typed.
  const lastTurnFailed = retryable !== null || activeSession?.status === 'failed';
  // No second copy of the drafts: they already survive every failure branch
  // (only the success branch clears them), so the live chips ARE the retry
  // payload. A snapshot would resurrect chips the user deleted after the
  // failure and make the status line under-report what is being sent.
  const retryDrafts = attachments.drafts;
  const canRetry =
    lastTurnFailed &&
    (Boolean(retryText) || retryDrafts.length > 0) &&
    Boolean(activeSessionId && activeWorkspace) &&
    !busy &&
    !sending &&
    attachments.reading === 0;
  const handleRetry = async () => {
    if (!canRetry) return;
    setRetryable(null);
    await runSend(retryText ?? '', retryDrafts);
  };

  const runSend = async (trimmed: string, drafts: readonly AttachmentDraft[]) => {
    // Explicit `cwd` check (independent of canSend): a null cwd is the demo
    // placeholder or a target with no path — creating a session against it
    // would persist a fake cwd into session-index.json and die in spawn on
    // the Host side.
    if (!canSend || !activeSessionId || !cwd) {
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const sessionId = activeSessionId;
    const workspacePath = cwd;
    const model = getSessionModel(sessionId) ?? defaultModelId(null);
    // T-20: undefined when the user left it on "Default", so the key is dropped
    // from the payload entirely and the model default applies (≠ pinning high).
    const effort = toWireEffort(getSessionEffort(sessionId));
    const wireAttachments = toWireAttachments(drafts);
    // RAW bytes (pre-base64) — the same unit every limit is expressed in.
    const attachmentBytes = totalAttachmentBytes(drafts);
    const timeoutMs = sendTimeoutMs(attachmentBytes);

    // 2026-07-28 continuity fix: decide, off a store snapshot and BEFORE any
    // IPC, whether the Host registry entry is still alive (direct send — no
    // close/create round-trip needed), gone but resumable (we still know its
    // runtimeIdentity), or genuinely new (create). Closing and recreating the
    // Host session on every send used to wipe the resume identity each turn,
    // silently starting a brand-new conversation every time.
    const preState = useChatSessionsStore.getState();
    const hostBound = preState.hostBoundSessionIds.includes(sessionId);
    const knownIdentity =
      preState.sessions.find((session) => session.id === sessionId)?.runtimeIdentity ?? null;
    const preamble = decideSendPreamble({ hostBound, runtimeIdentity: knownIdentity });

    // Starting a fresh send invalidates any prior failure's retryable prompt:
    // the new prompt is what the user wants now, and a stale ghost Retry would
    // linger if the prior failed stream happened to settle later (see the
    // "Retry 重影" bug — flow aborted without result, `retryable` stayed,
    // a late assistant bubble appeared, Retry showed next to Send wrongly).
    setRetryable(null);
    // A skip warning belongs to the paste that produced it, not to the next
    // turn. Sending is one of the three clear triggers (next attach / Send / x).
    dismissAttachmentNotice();
    useChatSessionsStore.setState({ lastError: null });

    // T-28: all guards have passed and the send is committed — this is what
    // flips the middle column to the docked session state the same frame,
    // instead of waiting for the first echoed message (handleRetry reuses
    // runSend, so a retry re-docks too, which is correct: the column must
    // not bounce back to centered on a failed first send).
    onSendStart?.();

    setSending(true);
    setSendBudgetMs(timeoutMs);
    // Nothing has been transmitted yet: ensureHost / closeSession /
    // createSession still have to run, and that can take seconds.
    setSendPhase('handshake');
    setElapsedSeconds(0);
    phaseStartedAtRef.current = Date.now();
    const ticker = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - phaseStartedAtRef.current) / 1000));
    }, 1000);
    const seenEvents: string[] = [];
    const assistantMessageIds = new Set<string>();
    let sawSessionCreated = false;
    let sawSessionResumed = false;
    let sawAssistantProgress = false;
    let fatalHostError: string | null = null;
    let fatalHostErrorCode: string | null = null;

    const unsubEvents = window.electronAPI.chat.onRuntimeEvent((event) => {
      seenEvents.push(formatRuntimeEvent(event));

      if (event.type === 'session.created' && event.sessionId === sessionId) {
        sawSessionCreated = true;
      }

      if (event.type === 'session.resumed' && event.sessionId === sessionId) {
        sawSessionResumed = true;
      }

      if (event.sessionId === sessionId) {
        if (classifyAssistantProgress(event, assistantMessageIds) === 'assistant') {
          sawAssistantProgress = true;
        }
      }

      if (event.type === 'host.error') {
        const message =
          event.payload && typeof event.payload === 'object' && 'message' in event.payload
            ? String((event.payload as { message?: string }).message ?? 'host.error')
            : 'host.error';
        const code =
          event.payload && typeof event.payload === 'object' && 'code' in event.payload
            ? String((event.payload as { code?: string }).code ?? '')
            : '';
        fatalHostErrorCode = code || null;
        fatalHostError = code ? `${code}: ${message}` : message;
        useChatSessionsStore.setState({ lastError: fatalHostError });
      }
    });

    // A broken binding must not be retried as-is next send: the following
    // send should go through 'resume' (if the runtimeIdentity is still known)
    // or 'create' fresh, never silently reuse a registry entry the Host
    // already dropped.
    const unbindHost = () => {
      useChatSessionsStore.setState((state) => ({
        hostBoundSessionIds: state.hostBoundSessionIds.filter((id) => id !== sessionId),
      }));
    };

    const setCreateTimeoutError = () => {
      useChatSessionsStore.setState({
        lastError: [
          'Timed out waiting for session.created after createSession.',
          `rawEvents=[${seenEvents.join(' ; ') || 'none'}]`,
          `sessionId=${sessionId}`,
        ].join(' | '),
      });
    };

    /** close → sleep(120) → create → wait for session.created. */
    const runCreateSequence = async (): Promise<'ok' | 'fatal' | 'timeout'> => {
      // Drop Host registry entry so createSession is not "Session already exists".
      await window.electronAPI.chat.closeSession({ sessionId }).catch(() => undefined);
      await sleep(120);

      sawSessionCreated = false;
      await window.electronAPI.chat.createSession({
        sessionId,
        workspacePath,
        model,
        ...(effort ? { effort } : {}),
      });

      const created = await waitUntil(() => sawSessionCreated || Boolean(fatalHostError), 5000);
      if (fatalHostError) return 'fatal';
      if (!created) return 'timeout';

      useChatSessionsStore.setState((state) => ({
        hostBoundSessionIds: state.hostBoundSessionIds.includes(sessionId)
          ? state.hostBoundSessionIds
          : [...state.hostBoundSessionIds, sessionId],
        lastError: null,
      }));
      return 'ok';
    };

    /** Send the turn, then wait for assistant / tool / permission / terminal progress. */
    const sendAndWait = async (): Promise<boolean> => {
      await window.electronAPI.chat.send({
        sessionId,
        text: trimmed,
        ...(wireAttachments ? { attachments: wireAttachments } : {}),
      });
      // The payload is with the Host now, so the status line may say so — and
      // the clock restarts, because `timeoutMs` budgets this phase alone.
      phaseStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setSendPhase('awaiting');
      setValue('');

      // Running alone is not success — wait for assistant / tool / permission / terminal.
      return waitUntil(() => {
        if (fatalHostError) return true;
        if (sawAssistantProgress) return true;
        const state = useChatSessionsStore.getState();
        if (state.lastError) return true;
        const session = state.sessions.find((item) => item.id === sessionId);
        if (session?.status === 'failed') return true;
        if (session?.status === 'waiting_permission' || session?.status === 'waiting_question') {
          return true;
        }
        const hasAssistant = (state.messages[sessionId] ?? []).some(
          (message) => message.role === 'assistant' && message.blocks.length > 0
        );
        return hasAssistant;
        // T-18: the budget scales with the payload and is clamped below the
        // Host stall watchdog. sendTimeoutMs(0) is still exactly 45000, so the
        // text-only path waits precisely as long as it did before.
      }, timeoutMs);
    };

    try {
      await window.electronAPI.chat.ensureHost();

      if (preamble.action === 'create') {
        const seq = await runCreateSequence();
        if (seq === 'fatal') {
          unbindHost();
          return;
        }
        if (seq === 'timeout') {
          unbindHost();
          setCreateTimeoutError();
          return;
        }
      } else if (preamble.action === 'resume') {
        sawSessionResumed = false;
        await window.electronAPI.chat
          .resumeSession({
            sessionId,
            runtimeIdentity: preamble.runtimeIdentity,
            workspacePath,
            model,
            ...(effort ? { effort } : {}),
          })
          .catch(() => undefined);

        const resumed = await waitUntil(() => sawSessionResumed || Boolean(fatalHostError), 5000);
        if (!resumed || fatalHostError) {
          // Resume failed or timed out (stale identity / Host hiccup / etc.)
          // — fall through ONCE to a fresh session rather than fail the turn.
          fatalHostError = null;
          fatalHostErrorCode = null;
          useChatSessionsStore.setState({ lastError: null });

          const seq = await runCreateSequence();
          if (seq === 'fatal') {
            unbindHost();
            return;
          }
          if (seq === 'timeout') {
            unbindHost();
            setCreateTimeoutError();
            return;
          }
        } else {
          useChatSessionsStore.setState((state) => ({
            hostBoundSessionIds: state.hostBoundSessionIds.includes(sessionId)
              ? state.hostBoundSessionIds
              : [...state.hostBoundSessionIds, sessionId],
            lastError: null,
          }));
        }
      }
      // 'direct': the Host registry entry is already alive — no close/create
      // round-trip, straight to send below.

      let ok = await sendAndWait();

      if (preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found') {
        // The Host dropped the registry entry behind our back (Host restart,
        // a stale binding, etc.) — fall through ONCE to a fresh session and
        // resend, instead of failing a turn the user has no way to recover.
        fatalHostError = null;
        fatalHostErrorCode = null;
        unbindHost();
        useChatSessionsStore.setState({ lastError: null });

        const seq = await runCreateSequence();
        if (seq === 'fatal') {
          unbindHost();
          return;
        }
        if (seq === 'timeout') {
          unbindHost();
          setCreateTimeoutError();
          return;
        }
        ok = await sendAndWait();
      }

      if (fatalHostError || useChatSessionsStore.getState().lastError) {
        unbindHost();
        return;
      }

      const statusAfter = useChatSessionsStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.status;
      if (
        ok &&
        (sawAssistantProgress ||
          statusAfter === 'waiting_permission' ||
          statusAfter === 'waiting_question' ||
          statusAfter === 'idle')
      ) {
        // Success — clear any stale failure UI so a ghost Retry can't resurface
        // later (e.g. prior failed stream settled and pushed an assistant bubble).
        setRetryable(null);
        // T-18: attachments are cleared here and nowhere else. On any failure
        // they stay visible, which is both the Retry payload and the only
        // evidence of what the turn carried (the timeline does not render them).
        clearAttachmentDrafts();
        useChatSessionsStore.setState({ lastError: null });
        return;
      }

      unbindHost();
      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      const hostAfter = await window.electronAPI.chat.getHostStatus().catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));

      useChatSessionsStore.setState({
        lastError: [
          'No assistant/tool progress after send (status may still show idle/stopped — Host did not emit failed; the SDK stream likely hung or errored without a result event).',
          `status=${session?.status ?? 'n/a'}`,
          `rawEvents=[${seenEvents.join(' ; ') || 'none'}]`,
          `hostAfter=${JSON.stringify(hostAfter)}`,
          `sessionId=${sessionId}`,
          `cwd=${workspacePath}`,
          'Click Retry to resend, or Stop. Check Claude auth / API in your CLAUDE_CONFIG_DIR settings.json.',
        ].join(' | '),
      });
      setRetryable({ text: trimmed });
    } catch (err) {
      unbindHost();
      useChatSessionsStore.setState({
        lastError: err instanceof Error ? err.message : String(err),
      });
      setRetryable({ text: trimmed });
    } finally {
      window.clearInterval(ticker);
      setElapsedSeconds(0);
      inFlightRef.current = false;
      unsubEvents();
      setSending(false);
    }
  };

  const hasStatusError = Boolean(lastError || !activeSessionId || !activeWorkspace);
  const readingLine =
    attachments.reading > 0
      ? `Reading ${attachments.reading} file${attachments.reading > 1 ? 's' : ''}…`
      : null;
  const largeHint = largeAttachmentHint(attachments.drafts);
  const statusLine =
    readingLine ??
    (sending
      ? composerSendingLine({
          phase: sendPhase,
          elapsedSeconds,
          budgetMs: sendBudgetMs,
          attachmentCount: attachments.drafts.length,
          attachmentBytes: attachments.totalBytes,
        })
      : (!hasStatusError && largeHint) || statusHint);
  const statusTone =
    sending && elapsedSeconds >= SLOW_WAIT_HINT_SECONDS
      ? 'text-warning'
      : !sending && hasStatusError
        ? 'text-destructive'
        : 'text-muted-foreground';

  // T-28: whether the status line renders at all — the empty card always
  // shows it, the docked follow-up card hides its resting state (§3.1 /
  // shouldShowStatusLine) so a static "Ready · cwd:" line doesn't inflate the
  // 40px docked height.
  const showStatusLine = shouldShowStatusLine({
    mode,
    sending,
    reading: attachments.reading,
    hasStatusError,
    hasLargeHint: Boolean(largeHint),
  });
  // Wrapper class differs by mode: empty mode's status area fills the gap in
  // a `justify-between` row (needs flex-1 to truncate instead of pushing the
  // button group off), session mode's row already gives the growth budget to
  // the textarea, so the status area only needs to shrink, not grow.
  const renderStatusLine = (wrapperClassName: string) =>
    showStatusLine ? (
      <div className={wrapperClassName}>
        {/* A send can stay silent for a minute — the spinner and the ticking
              seconds are what tell the user it is alive rather than hung. */}
        {(sending || attachments.reading > 0) && (
          <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <p className={cn('min-w-0 truncate text-xs tabular-nums', statusTone)} title={statusLine}>
          {statusLine}
        </p>
      </div>
    ) : null;

  const noticeBlock = attachments.notice ? (
    <Alert
      variant={attachments.notice.tone === 'info' ? 'info' : 'warning'}
      className="mt-1 items-center gap-x-2 px-2 py-1 text-xs"
    >
      <TriangleAlert />
      <AlertTitle className="min-w-0 truncate font-normal" title={attachments.notice.message}>
        {attachments.notice.message}
      </AlertTitle>
      <AlertAction>
        <button
          type="button"
          onClick={attachments.dismissNotice}
          aria-label="Dismiss attachment notice"
          className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </AlertAction>
    </Alert>
  ) : null;

  const attachmentChipsBlock =
    attachments.drafts.length > 0 ? (
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {attachments.drafts.map((draft) => (
          <AttachmentChip
            key={draft.id}
            draft={draft}
            sending={sending}
            onRemove={attachments.removeDraft}
          />
        ))}
      </div>
    ) : null;

  const mentionChipsBlock =
    mentionChips.length > 0 ? (
      <div className="mt-1 flex flex-wrap gap-1">
        {mentionChips.map((chip, idx) => (
          <span
            key={`${chip.path}-${idx}`}
            className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
          >
            {chip.path}
          </span>
        ))}
      </div>
    ) : null;

  // T-28 §3.4 point 7: in the docked follow-up card, notice/attachment
  // chips/mention chips must never be silently hidden (that would be the
  // T-18 "invisible attachment" bug again) — they stack as the card's first
  // row, above the single control row, instead of disappearing.
  const hasComposerExtras = Boolean(noticeBlock || attachmentChipsBlock || mentionChipsBlock);

  const textareaEl = (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => handleContentChange(event.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        const ta = textareaRef.current;
        if (!cwd || !ta) {
          setMentionQuery(null);
          return;
        }
        setMentionQuery(extractMentionQuery(event.currentTarget.value, ta.selectionStart));
        setMentionIndex(0);
      }}
      // T-18: attachments only. This handler must never write `value` or
      // move the caret — that is what keeps plain-text paste and IME
      // composition byte-for-byte native.
      onPaste={attachments.handlePaste}
      placeholder={composerPlaceholder({
        mode,
        canSend,
        busy,
        sending,
        hasSession: Boolean(activeSessionId),
        hasWorkspace: Boolean(activeWorkspace),
        attachmentCount: attachments.drafts.length,
      })}
      className={composerTextareaClass(mode)}
      disabled={disabled || busy || sending || !activeSessionId}
      onKeyDown={(event) => {
        // T-07 @ popup：popup 开时拦截方向键 / Enter / Esc，避免误发。
        if (mentionOpen) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setMentionIndex((i) => (i + 1) % mentionResults.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            insertMention(mentionResults[mentionIndex]);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMentionQuery(null);
            setMentionResults([]);
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          // An IME confirming a candidate fires Enter before
          // compositionend — sending here would fire off a half-typed
          // message, and with attachments that is an expensive mistake.
          if (composingRef.current) return;
          event.preventDefault();
          void handleSend();
        }
      }}
    />
  );

  // T-28 §3.5: Model/Effort selects and the Send/Stop/Retry round buttons —
  // shared between both layout branches, only their position in the card
  // differs (bottom row in empty mode, inline in the single row in session
  // mode).
  const modelEffortControls = activeSessionId ? (
    <>
      <ModelSelect sessionId={activeSessionId} disabled={disabled || busy || sending} />
      {/* T-20: effort sits next to the model — both are per-session
            generation settings applied at the next createSession. */}
      <EffortSelect sessionId={activeSessionId} disabled={disabled || busy || sending} />
    </>
  ) : null;

  const actionButtons = (
    <>
      {canRetry && (
        <ComposerRoundButton kind="retry" disabled={disabled} onClick={() => void handleRetry()} />
      )}
      {canStop ? (
        <ComposerRoundButton
          kind="stop"
          disabled={disabled}
          onClick={() => void stopActiveSession()}
        />
      ) : (
        <ComposerRoundButton
          kind="send"
          // Attachment-only sends are legal; a still-encoding paste is not
          // (Enter would send the message without its files).
          disabled={
            !canSend ||
            (!value.trim() && attachments.drafts.length === 0) ||
            attachments.reading > 0
          }
          onClick={() => void handleSend()}
        />
      )}
    </>
  );

  return (
    // Wraps both the error banner and the composer card so they share the
    // timeline's reading width (T-22 spec §2.13 — "Composer 同栏宽"). The host
    // div in ChatWorkspace (`middleColumnHostClass`) owns the padding and the
    // shrink/grow behaviour for both modes now — no border/background here.
    <ReadingColumn>
      {(lastError || !activeSessionId || !activeWorkspace) && (
        <div className="mb-2 max-h-28 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive whitespace-pre-wrap break-all">
          {statusHint}
        </div>
      )}
      {/* T-28 §3.6: one ComposerTargetBar instance, rendered at one of two
            positions by mode — never both at once. Empty mode keeps the bar
            above the card (current position); session mode docks it below. */}
      {mode === 'empty' && (
        <ComposerTargetBar
          mode={mode}
          sending={sending}
          disabled={disabled}
          onAddRepository={onAddRepository}
        />
      )}
      <div className={composerCardClass(mode)}>
        {/* T-07 @ 文件搜索 popup——放 textarea 上方/下方，避免被 overflow-hidden 容器裁掉 */}
        {mentionOpen && (
          <div
            className={cn(
              'absolute left-2 w-72 overflow-hidden rounded-lg border bg-popover shadow-lg',
              mentionPopupPlacementClass(mode)
            )}
          >
            <div className="max-h-[240px] overflow-y-auto py-1">
              {mentionResults.map((item, i) => {
                const lastSep = item.relativePath.lastIndexOf('/');
                const dirPart = lastSep > 0 ? item.relativePath.slice(0, lastSep) : '';
                const fileName =
                  lastSep > 0 ? item.relativePath.slice(lastSep + 1) : item.relativePath;
                return (
                  <button
                    type="button"
                    key={item.path}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(item);
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-sm transition-colors',
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50'
                    )}
                  >
                    {/* T-07①: directories are selectable now — mark them so a
                          folder is not mistaken for a same-named file. */}
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {item.isDirectory ? (
                        <Folder className="size-3.5 shrink-0 text-folder" />
                      ) : (
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {fileName}
                        {item.isDirectory ? '/' : ''}
                      </span>
                    </span>
                    {dirPart && (
                      <span className="ml-1.5 text-xs text-muted-foreground">{dirPart}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  Enter
                </kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  Esc
                </kbd>
                Close
              </span>
              {/* T-07③: searching `chat` here matches 304 files but only 10
                    render — say so instead of truncating silently. */}
              {mentionTotal > mentionResults.length && (
                <span className="ml-auto shrink-0 tabular-nums">
                  {mentionResults.length}/{mentionTotal}
                </span>
              )}
            </div>
          </div>
        )}
        {mode === 'session' ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {hasComposerExtras && (
              <div className="mb-1 flex flex-col gap-1">
                {noticeBlock}
                {attachmentChipsBlock}
                {mentionChipsBlock}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              {textareaEl}
              {renderStatusLine('flex min-w-0 shrink items-center gap-1.5')}
              {modelEffortControls}
              {actionButtons}
            </div>
          </div>
        ) : (
          <>
            {textareaEl}
            {noticeBlock}
            {attachmentChipsBlock}
            {mentionChipsBlock}
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {renderStatusLine('flex min-w-0 flex-1 items-center gap-1.5')}
              <div className="flex shrink-0 items-center gap-1.5">
                {modelEffortControls}
                {actionButtons}
              </div>
            </div>
          </>
        )}
      </div>
      {mode === 'session' && (
        <ComposerTargetBar
          mode={mode}
          sending={sending}
          disabled={disabled}
          onAddRepository={onAddRepository}
        />
      )}
    </ReadingColumn>
  );
}
