/**
 * U06-a: the Run surface — the active conversation's live turn state.
 *
 * Every value comes from a source already wired for something else (the
 * chatSessions store, `useMessageMetadata`, `useSessionEffort`,
 * `turnSendStatus`); this view only lays them out. The derivation lives in
 * `runPanelModel.ts` so the status mapping and the cross-session guard are
 * testable under the repo's node-env vitest.
 *
 * U06-b filled in the two things that were missing: the context-occupancy ring
 * and the usage rows. Both are runtime-reported (T38-a's `usage.updated`,
 * T38-b's catalog `contextWindow`) — nothing on this surface divides characters
 * by four and calls the result tokens. When the runtime has not reported
 * occupancy, the ring is absent rather than empty.
 */
import { agentDefaultEffort } from '@shared/models/chatAgentDefaults';
import type { ContextOccupancy } from '@shared/piUsage';
import { Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { formatTokenTotal } from '@/components/chat/countFormat';
import { EFFORT_DEFAULT_ID, effortLabel, resolveEffortSelection } from '@/components/chat/efforts';
import { useHostStatus } from '@/components/chat/useHostStatus';
import { useMessageMetadata } from '@/components/chat/useMessageMetadata';
import { usePiModelCatalog } from '@/components/chat/usePiModelCatalog';
import { useResolvedSessionModel } from '@/components/chat/useResolvedSessionModel';
import { useSessionEffort } from '@/components/chat/useSessionEffort';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
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

/**
 * U06-b: the occupancy ring — used vs free against the model's own context
 * window, drawn with the same `pathLength={100}` normalization the Context
 * surface's composition donut uses, so the dash pattern IS the percentage
 * printed in the middle.
 *
 * Two arcs and no role breakdown, on purpose. pi-app's ring colours its used
 * portion by role, but its role shares come from dividing characters by four;
 * ours would then mix a runtime-measured total with an estimated split inside
 * the same ring, and a reader has no way to tell which half of the picture is
 * measured. The per-role view stays where its data lives — the Context
 * surface's composition chart, which is labelled in characters.
 */
function OccupancyRing({ occupancy, label }: { occupancy: ContextOccupancy; label: string }) {
  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 42 42" className="h-20 w-20" role="img" aria-label={label}>
        <circle
          cx="21"
          cy="21"
          r="15.9"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="5"
          pathLength={100}
        />
        <circle
          cx="21"
          cy="21"
          r="15.9"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="5"
          pathLength={100}
          strokeDasharray={`${occupancy.percent} ${100 - occupancy.percent}`}
          transform="rotate(-90 21 21)"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-ui font-semibold tabular-nums leading-none">
          {`${Math.round(occupancy.percent)}%`}
        </span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {formatTokenTotal(occupancy.usedTokens)}
        </span>
      </div>
    </div>
  );
}

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
  const usage = useSessionRuntimeFactsStore((state) =>
    activeSessionId ? (state.factsBySession[activeSessionId]?.usage ?? null) : null
  );
  const toolStatus = useSessionRuntimeFactsStore((state) =>
    activeSessionId ? (state.factsBySession[activeSessionId]?.activeToolStatus ?? null) : null
  );
  // T38-b: the configured model's declared window, for the case where nothing
  // has run yet. Reads the same renderer-wide catalog cache the composer's
  // model picker fills, so this panel adds no extra fetch.
  const { status: hostStatus } = useHostStatus();
  const { catalog } = usePiModelCatalog(hostStatus.state);

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

  const configuredModelId = activeSessionId ? (resolveSessionModel(activeSessionId) ?? null) : null;
  const configuredContextWindow = useMemo(() => {
    if (!configuredModelId) return null;
    const option = catalog?.models.find((model) => model.id === configuredModelId);
    return option?.contextWindow ?? null;
  }, [catalog, configuredModelId]);

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
    configuredModel: configuredModelId,
    effortLabel: activeSessionId
      ? effortLabel(
          resolveEffortSelection(
            getSessionEffort(activeSessionId),
            agentDefaultEffort(chatAgentDefaults)
          ) ?? EFFORT_DEFAULT_ID
        )
      : null,
    lastTurnMs: lastMeta?.latencyMs ?? null,
    usage,
    configuredContextWindow,
    toolStatus,
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
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-muted px-1.5 py-1">
            <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-meta" title={view.tools.activeTool}>
                {view.tools.activeTool}
              </div>
              {view.tools.activeToolStatus && (
                <div
                  className="truncate text-2xs text-muted-foreground"
                  title={view.tools.activeToolStatus}
                >
                  {view.tools.activeToolStatus}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {view.occupancy && (
        <div className="flex shrink-0 items-center gap-3 border-b p-2">
          <OccupancyRing occupancy={view.occupancy} label={t('Context used')} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2 text-meta">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-xs"
                style={{ background: 'var(--primary)' }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('Used')}</span>
              <span className="shrink-0 tabular-nums">
                {formatTokenTotal(view.occupancy.usedTokens)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-meta">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-xs"
                style={{ background: 'var(--muted)' }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('Free')}</span>
              <span className="shrink-0 tabular-nums">
                {formatTokenTotal(view.occupancy.freeTokens)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{t('Context window')}</span>
              <span className="shrink-0 tabular-nums">
                {formatTokenTotal(view.occupancy.contextWindow)}
              </span>
            </div>
          </div>
        </div>
      )}

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
            {/* Only when there is no ring: with occupancy on screen the window
                is already printed beside it, and repeating it here would read
                as a second, unrelated number. */}
            {view.contextWindowOnly !== null && (
              <RunMetric
                label={t('Context window')}
                value={formatTokenTotal(view.contextWindowOnly)}
              />
            )}
          </>
        )}
        {/* Labelled "last turn" throughout: a Pi run that calls tools settles
            several turns, and each `usage.updated` is that turn's own bill —
            summing them would print a total nobody was charged. */}
        {view.usage && (
          <div className="mt-1 flex flex-col border-t pt-1">
            <RunMetric label={t('Input (last turn)')} value={formatTokenTotal(view.usage.input)} />
            <RunMetric
              label={t('Output (last turn)')}
              value={formatTokenTotal(view.usage.output)}
            />
            {view.usage.cacheRead > 0 && (
              <RunMetric label={t('Cache read')} value={formatTokenTotal(view.usage.cacheRead)} />
            )}
            {view.usage.cacheWrite > 0 && (
              <RunMetric label={t('Cache write')} value={formatTokenTotal(view.usage.cacheWrite)} />
            )}
            {view.usage.costUsd > 0 && (
              <RunMetric label={t('Cost')} value={`$${view.usage.costUsd.toFixed(4)}`} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
