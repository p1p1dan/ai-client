/**
 * U06-a: the Run surface — the active conversation's live turn state.
 *
 * Every value comes from a source already wired for something else (the
 * chatSessions store, `useMessageMetadata`, `useSessionEffort`,
 * `turnSendStatus`); this view only lays them out. The derivation lives in
 * `runPanelModel.ts` so the status mapping and the cross-session guard are
 * testable under the repo's node-env vitest.
 *
 * The context-occupancy donut and the usage/cost rows pi-app shows are NOT
 * here: Pi's worker emits no `usage.updated` and the catalog strips
 * `contextWindow`, so they wait on the Pi plan's T38 (U06-b). Nothing renders
 * a placeholder for them in the meantime.
 */
import { agentDefaultEffort } from '@shared/models/chatAgentDefaults';
import { Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { EFFORT_DEFAULT_ID, effortLabel, resolveEffortSelection } from '@/components/chat/efforts';
import { useMessageMetadata } from '@/components/chat/useMessageMetadata';
import { useResolvedSessionModel } from '@/components/chat/useResolvedSessionModel';
import { useSessionEffort } from '@/components/chat/useSessionEffort';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import type { SurfaceViewProps } from '../surfaceViews';
import { deriveRunPanelView, type RunTone } from './runPanelModel';

// Stable snapshot for "session has no bucket yet" — a fresh `[]` per selector
// call makes zustand v5's `useSyncExternalStore` re-render forever.
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

const TONE_BADGE: Record<RunTone, 'secondary' | 'info' | 'warning' | 'error'> = {
  idle: 'secondary',
  active: 'info',
  attention: 'warning',
  error: 'error',
};

const TONE_BAR: Record<RunTone, string> = {
  idle: 'bg-transparent',
  active: 'bg-info',
  attention: 'bg-warning',
  error: 'bg-destructive',
};

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-7 items-center gap-2 px-1">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-ui tabular-nums" title={value}>
        {value}
      </span>
    </div>
  );
}

export function RunSurfaceView(_props: SurfaceViewProps) {
  const { t } = useI18n();

  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const messageBucket = useChatSessionsStore((state) =>
    activeSessionId ? state.messages[activeSessionId] : undefined
  );
  const messages = messageBucket ?? EMPTY_MESSAGES;
  // Unfiltered on purpose: `deriveRunPanelView` owns the "does this snapshot
  // belong to the session on screen" decision, so there is one guard, tested.
  const turnSendStatus = useTurnSendStatusStore((state) => state.status);

  const resolveSessionModel = useResolvedSessionModel();
  const { getSessionEffort } = useSessionEffort();
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const { get: getMeta } = useMessageMetadata(activeSessionId);

  const session = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);
  const lastMeta = lastAssistantMessageId ? getMeta(lastAssistantMessageId) : undefined;

  const view = deriveRunPanelView({
    sessionId: activeSessionId,
    status: session?.status ?? null,
    messages,
    turnSend: turnSendStatus
      ? {
          sessionId: turnSendStatus.sessionId,
          phase: turnSendStatus.phase,
          elapsedSeconds: turnSendStatus.elapsedSeconds,
        }
      : null,
    // A06: `reportedModel` only — `.model` silently falls back to the local
    // pick, which would make a guess look like the runtime's own answer.
    actualModel: lastMeta?.reportedModel ?? null,
    configuredModel: activeSessionId ? (resolveSessionModel(activeSessionId) ?? null) : null,
    effortLabel: activeSessionId
      ? effortLabel(
          resolveEffortSelection(
            getSessionEffort(activeSessionId),
            agentDefaultEffort(chatAgentDefaults)
          ) ?? EFFORT_DEFAULT_ID
        )
      : null,
    lastTurnMs: lastMeta?.latencyMs ?? null,
  });

  if (!activeSessionId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-meta text-muted-foreground">{t('No active session.')}</p>
      </div>
    );
  }

  return (
    <div className="select-text flex h-full flex-col overflow-y-auto">
      <div className="relative shrink-0 border-b p-2">
        <span
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5', TONE_BAR[view.tone])}
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui font-medium">{t(view.headline)}</span>
          {view.elapsedLabel && (
            <Badge variant={TONE_BADGE[view.tone]} size="sm" className="tabular-nums">
              {view.elapsedLabel}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
          {view.model ? (
            <span className="min-w-0 truncate" title={view.model}>
              {view.model}
            </span>
          ) : (
            <span>{t('No model configured')}</span>
          )}
          {view.effortLabel && <span className="shrink-0">· {t(view.effortLabel)}</span>}
          {/* The phase is only meaningful while a turn is actually in flight. */}
          {view.elapsedLive && view.phase && <span className="shrink-0">· {view.phase}</span>}
        </div>

        {view.tools.activeTool && (
          <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-1">
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-meta" title={view.tools.activeTool}>
              {view.tools.activeTool}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col p-2">
        {view.empty ? (
          <p className="px-1 py-2 text-meta text-muted-foreground">{t('Nothing has run yet.')}</p>
        ) : (
          <>
            {view.status && <RunMetric label={t('Status')} value={view.status} />}
            {view.elapsedLabel && (
              <RunMetric
                label={view.elapsedLive ? t('Elapsed') : t('Last turn')}
                value={view.elapsedLabel}
              />
            )}
            {view.model && (
              <RunMetric
                label={view.modelReported ? t('Model (actual)') : t('Model (configured)')}
                value={view.model}
              />
            )}
            {view.tools.calls > 0 && (
              <RunMetric label={t('Tool calls')} value={String(view.tools.calls)} />
            )}
            {view.tools.failed > 0 && (
              <RunMetric label={t('Failed tools')} value={String(view.tools.failed)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
