/**
 * T-14: the Context surface — a read-only definition list of the active
 * session's real, already-tracked facts (Workspace / Runtime / Session).
 * Every value below is sourced from an existing store/hook; nothing here
 * invents state (A06). See `contextSurfaceModel.ts` for the field table and
 * "field missing → row omitted, group empty → group omitted" rules this view
 * only renders, never decides.
 */
import { agentDefaultEffort } from '@shared/models/chatAgentDefaults';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveEffortSelection } from '@/components/chat/efforts';
import { useHostStatus } from '@/components/chat/useHostStatus';
import { useMessageMetadata } from '@/components/chat/useMessageMetadata';
import { useResolvedSessionModel } from '@/components/chat/useResolvedSessionModel';
import { useSessionEffort } from '@/components/chat/useSessionEffort';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useSettingsStore } from '@/stores/settings';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import type { SurfaceViewProps } from '../surfaceViews';
import {
  type ContextGroup,
  deriveContextGroups,
  deriveRunState,
  deriveSessionReferences,
} from './contextSurfaceModel';
import {
  type ConversationComposition,
  type ConversationRole,
  type ConversationSegment,
  deriveCompositionArcs,
  deriveConversationComposition,
  deriveSegmentPage,
  formatCharCount,
  formatShare,
} from './conversationSegments';

/**
 * U16: one colour per role, shared by the donut, the stacked bar and the
 * legend, so the three can never disagree about which slice is which.
 *
 * Semantic tokens, not a new palette: `--primary` is already the app's accent
 * (assistant text is the bulk of a transcript), `--info` marks the user's own
 * turns the same way the running dot does, and `--destructive` is what an
 * error message reads as everywhere else in this app.
 */
const ROLE_COLOR: Record<ConversationRole, string> = {
  assistant: 'var(--primary)',
  user: 'var(--info)',
  system: 'var(--muted-foreground)',
  error: 'var(--destructive)',
};

// Stable snapshot for "session has no bucket yet": zustand v5 reads selectors
// through `useSyncExternalStore`, so a fresh `[]` per call makes React see the
// store as changed on every commit and re-render forever.
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

function CopyRowButton({ value }: { value: string }) {
  const { t } = useI18n();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({
        title: t('Copied'),
        description: t('Path copied to clipboard'),
        type: 'success',
        timeout: 2000,
      });
    } catch {
      // Ignore clipboard errors — same as StatusLine's DirItem.
    }
  }, [value, t]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6 shrink-0"
      aria-label={t('Copy Path')}
      title={t('Copy Path')}
      onClick={() => void handleCopy()}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}

function ContextRowLine({ row }: { row: ContextGroup['rows'][number] }) {
  const { t } = useI18n();
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-1">
      <span className="text-meta text-muted-foreground shrink-0">{t(row.label)}</span>
      <span className="min-w-0 flex-1 truncate text-ui" title={row.title ?? row.value}>
        {row.value}
      </span>
      {row.copyable && <CopyRowButton value={row.value} />}
    </div>
  );
}

/**
 * U07: one collapsed row per loaded message — role, size, first line — that
 * opens to the message's own text. The body is bounded by
 * `SEGMENT_BODY_MAX_CHARS`; a cut one says so instead of ending mid-sentence
 * with no explanation.
 */
function ConversationSegmentRow({
  segment,
  expanded,
  onToggle,
}: {
  segment: ConversationSegment;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-left hover:bg-hover"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-meta text-muted-foreground">{t(segment.role)}</span>
        {segment.detail && (
          <span className="shrink-0 text-meta text-muted-foreground">{segment.detail}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-ui" title={segment.preview}>
          {segment.preview}
        </span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
          {formatCharCount(segment.chars)}
        </span>
      </button>
      {expanded && (
        <p className="mb-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-meta">
          {segment.body || t('(no text in this message)')}
          {segment.truncated && <span className="text-muted-foreground"> {t('… truncated')}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * U16: the composition chart — a donut plus a stacked bar over the same shares.
 *
 * ## Why this is NOT a "context window used" gauge
 *
 * The prototype this batch follows draws a `63% of 128k` ring. That number does
 * not exist here: the model catalog strips `contextWindow` and Pi's worker emits
 * no `usage.updated`, which is precisely what the Pi plan's T38 unlocks (U06-b).
 * Printing a share of a window we cannot measure — or dividing characters by
 * four and calling the result tokens — would put a number on screen that looks
 * like it came from the runtime. So the chart shows what IS measured: how the
 * transcript this window has loaded splits across roles, with the total in
 * characters. When T38 lands, the same chart gains a real denominator.
 */
function CompositionChart({ conversation }: { conversation: ConversationComposition }) {
  const { t } = useI18n();
  const arcs = deriveCompositionArcs(conversation.roles);

  return (
    <div className="mb-2 flex flex-col gap-2 px-1">
      <div className="flex items-center gap-3">
        <div className="relative h-20 w-20 shrink-0">
          <svg viewBox="0 0 42 42" className="h-20 w-20" role="img" aria-label={t('Composition')}>
            <circle
              cx="21"
              cy="21"
              r="15.9"
              fill="none"
              stroke="var(--muted)"
              strokeWidth="5"
              pathLength={100}
            />
            {arcs.map((arc) => (
              <circle
                key={arc.role}
                cx="21"
                cy="21"
                r="15.9"
                fill="none"
                stroke={ROLE_COLOR[arc.role]}
                strokeWidth="5"
                // `pathLength` normalizes the circumference to 100, so the dash
                // pattern is literally the percentages the legend prints.
                pathLength={100}
                strokeDasharray={`${arc.dash} ${100 - arc.dash}`}
                strokeDashoffset={arc.offset}
                transform="rotate(-90 21 21)"
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-ui font-semibold tabular-nums leading-none">
              {formatCharCount(conversation.totalChars)}
            </span>
            <span className="text-2xs text-muted-foreground">{t('chars')}</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {conversation.roles.map((role) => (
            <div key={role.role} className="flex items-center gap-2 text-meta">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-xs"
                style={{ background: ROLE_COLOR[role.role] }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t(role.role)}</span>
              <span className="shrink-0 tabular-nums">{formatCharCount(role.chars)}</span>
              <span className="w-9 shrink-0 text-right text-muted-foreground tabular-nums">
                {formatShare(role.share)}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* The same shares again as one horizontal bar. Not redundant decoration:
          the donut answers "roughly what mix", the bar answers "in what
          proportion" at a glance for the two-role case where a donut is hardest
          to read. */}
      <div className="flex h-2 overflow-hidden rounded-xs bg-muted">
        {conversation.roles.map((role) => (
          <span
            key={role.role}
            aria-hidden
            style={{ width: `${role.share * 100}%`, background: ROLE_COLOR[role.role] }}
          />
        ))}
      </div>
    </div>
  );
}

export function ContextSurfaceView(_props: SurfaceViewProps) {
  const { t } = useI18n();

  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  const messageBucket = useChatSessionsStore((state) =>
    activeSessionId ? state.messages[activeSessionId] : undefined
  );
  const messages = messageBucket ?? EMPTY_MESSAGES;

  const { status: hostStatus } = useHostStatus();
  const resolveSessionModel = useResolvedSessionModel();
  const { getSessionEffort } = useSessionEffort();
  // The template rung of the effort chain. Subscribed rather than read through
  // `getState()` because this surface re-renders off store changes and an
  // effort template edited in Settings has to show up here without a click.
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const { get: getMeta } = useMessageMetadata(activeSessionId);

  // Session-scoped, same filter useTurnSendStatusStore's other readers use
  // (MessageTimeline.tsx) — a session switch mid-send must not show this
  // surface another session's clock.
  const turnSendStatus = useTurnSendStatusStore((state) =>
    state.status && activeSessionId && state.status.sessionId === activeSessionId
      ? state.status
      : null
  );

  // T-35: the stored facts object is returned as-is (reducer replaces it per
  // event) — stable across unrelated commits, per storeSelectorStability.
  const stderrFacts = useSessionRuntimeFactsStore((state) =>
    activeSessionId ? (state.factsBySession[activeSessionId]?.stderr ?? null) : null
  );

  const session = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === session?.workspaceId) ?? null,
    [workspaces, session]
  );

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);
  // A06: `reportedModel` only — NEVER `.model`, which silently falls back to
  // the session's configured selection (messageMetadata.ts) and would make
  // an unconfirmed guess masquerade as "what actually answered".
  const actualModel = lastAssistantMessageId
    ? (getMeta(lastAssistantMessageId)?.reportedModel ?? null)
    : null;

  // D48 S2: `Automatic` resolves to `undefined` here, which this surface shows
  // as "no configured model" rather than inventing a name — the Context panel
  // is a mirror of what the runtime was told, and it was told nothing.
  const configuredModel = activeSessionId ? (resolveSessionModel(activeSessionId) ?? null) : null;
  // Both rungs of §4.3's chain, exactly as the send path resolves them: a
  // session that never picked an effort still sends its agent template's level,
  // so a mirror reading only the session's own storage would report "not
  // configured" while `effort:'high'` was on the wire. `undefined` (no session)
  // stays distinct from `null` (session, nothing configured) — that is what
  // decides between "row omitted" and "row says none".
  const effortSelection =
    activeSessionId && session
      ? resolveEffortSelection(
          getSessionEffort(activeSessionId),
          agentDefaultEffort(chatAgentDefaults)
        )
      : undefined;

  const groups = useMemo(() => {
    const runState = session
      ? deriveRunState({
          status: session.status,
          retry: session.retry ?? null,
          turnSend: turnSendStatus
            ? { phase: turnSendStatus.phase, elapsedSeconds: turnSendStatus.elapsedSeconds }
            : null,
        })
      : null;
    const references = activeSessionId
      ? deriveSessionReferences({ sessionId: activeSessionId, messages, pendingPermissions })
      : null;

    return deriveContextGroups({
      workspace: workspace
        ? {
            path: workspace.path,
            kind: workspace.kind,
            branch: workspace.branch ?? null,
            gitEnabled: workspace.gitEnabled,
          }
        : null,
      runtime: {
        configuredModel,
        actualModel,
        effortSelection,
        host: {
          state: hostStatus.state,
          pid: hostStatus.pid,
          driver: hostStatus.driver,
          version: hostStatus.cometixVersion,
          appVersion: window.electronAPI?.env.appVersion ?? null,
          authTokenType: hostStatus.settings?.authTokenType ?? null,
          baseHost: hostStatus.settings?.baseHost ?? null,
        },
      },
      session:
        session && runState && references
          ? {
              status: runState.status,
              retryLabel: runState.retryLabel,
              turnSendLabel: runState.turnSendLabel,
              pendingPermissionsCount: references.pendingPermissionsCount,
              attachments: references.attachments,
              mentions: references.mentions,
              runtimeIdentity: session.runtimeIdentity ?? null,
            }
          : null,
      stderr: stderrFacts,
    });
  }, [
    session,
    turnSendStatus,
    activeSessionId,
    messages,
    pendingPermissions,
    workspace,
    configuredModel,
    actualModel,
    effortSelection,
    hostStatus,
    stderrFacts,
  ]);

  // U07: the composition of what this window has loaded. Memoized on the
  // bucket identity — the store replaces only the message it touched, so a
  // streaming turn re-measures one message, not the session (see the per-block
  // cache in `conversationSegments.ts`).
  const conversation = useMemo(() => deriveConversationComposition(messages), [messages]);
  const [expandedSegments, setExpandedSegments] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  // U16: the per-message list starts CLOSED, and opening it still pages. See
  // `SEGMENT_PAGE_SIZE` for why both, not either.
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [showAllSegments, setShowAllSegments] = useState(false);
  const segmentPage = deriveSegmentPage(conversation.segments, showAllSegments);
  // Expansion is per message id, and ids are session-scoped: carrying the set
  // across a session switch would open whatever happened to collide. The list's
  // own open/paged state resets with it — a 400-message session inheriting the
  // previous one's "show all" is exactly the blow-up this is guarding against.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId is the reset TRIGGER, not a value the body reads
  useEffect(() => {
    setExpandedSegments(new Set<string>());
    setSegmentsOpen(false);
    setShowAllSegments(false);
  }, [activeSessionId]);
  const toggleSegment = useCallback((id: string) => {
    setExpandedSegments((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  return (
    <div className={cn('select-text flex h-full flex-col overflow-y-auto p-2')}>
      {groups.map((group) => (
        <div key={group.id} className="mb-3 flex flex-col">
          <p className="px-1 py-1 text-meta font-medium text-muted-foreground">{t(group.label)}</p>
          <div className="flex flex-col">
            {group.rows.map((row) => (
              <ContextRowLine key={row.id} row={row} />
            ))}
          </div>
        </div>
      ))}
      {conversation.totalMessages > 0 && (
        <div className="mb-3 flex flex-col">
          <p className="px-1 py-1 text-meta font-medium text-muted-foreground">
            {t('Conversation (loaded)')}
          </p>
          {/* Says plainly what this counts. The runtime's real context window
              is not knowable here — the model catalog strips `contextWindow`
              and Pi emits no usage — so the panel describes the transcript it
              has rather than implying it read the context. */}
          <p className="px-1 pb-1 text-meta text-muted-foreground">
            {t('{{count}} messages · {{chars}} chars in this window', {
              count: conversation.totalMessages,
              chars: formatCharCount(conversation.totalChars),
            })}
          </p>
          {/* U16: the shares, as a picture. The per-role table it replaces said
              the same thing in three columns of digits. */}
          <CompositionChart conversation={conversation} />
          <button
            type="button"
            aria-expanded={segmentsOpen}
            onClick={() => setSegmentsOpen((prev) => !prev)}
            className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-left hover:bg-hover"
          >
            {segmentsOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-ui">{t('Message breakdown')}</span>
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
              {conversation.totalMessages}
            </span>
          </button>
          {segmentsOpen && (
            <div className="mt-1 flex flex-col">
              {segmentPage.visible.map((segment) => (
                <ConversationSegmentRow
                  key={segment.id}
                  segment={segment}
                  expanded={expandedSegments.has(segment.id)}
                  onToggle={() => toggleSegment(segment.id)}
                />
              ))}
              {segmentPage.hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllSegments(true)}
                  className="flex h-7 w-full items-center rounded-md px-1 pl-5 text-meta text-muted-foreground hover:bg-hover"
                >
                  {t('Show more')} (<span className="tabular-nums">{segmentPage.hiddenCount}</span>)
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {groups.length === 0 && conversation.totalMessages === 0 && (
        <p className="px-1 py-2 text-meta text-muted-foreground">{t('No context reported yet.')}</p>
      )}
    </div>
  );
}
