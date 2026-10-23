import { useMemo } from 'react';
import { requestComposerCompact } from '@/components/chat/composerFocus';
import { formatTokenTotal } from '@/components/chat/countFormat';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { selectCompactPhase, useCompactRunsStore } from '@/stores/compactRuns';
import {
  type ConversationBucketId,
  deriveConversationComposition,
  formatShare,
} from '../surfaces/conversationSegments';
import { RailCard } from './RailCard';
import type { ContextCardView } from './sessionRailModel';

const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/** The context surface's bucket colours (`ContextSurfaceView`'s `BUCKET_COLOR`). */
const BUCKET_COLOR: Record<ConversationBucketId, string> = {
  user: 'var(--info)',
  assistant: 'var(--primary)',
  tools: 'var(--folder)',
  thinking: 'var(--muted-foreground)',
};

/** Literal keys so the i18n coverage test sees them (same as the surface). */
const BUCKET_LABEL: Record<ConversationBucketId, string> = {
  user: 'Your instructions',
  assistant: 'Assistant reply',
  tools: 'Tool output',
  thinking: 'Thinking content',
};

/** A 32px track, filled to the share in use — the reference's header bar. */
function ContextMeter({ percent, label }: { percent: number; label: string }) {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="flex h-1 w-8 shrink-0 overflow-hidden rounded-full bg-fill-neutral"
    >
      <span className="h-full bg-muted-foreground" style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * Layout 5e: the context card. The header says how full the window is;
 * open, it shows the tokens in use, the transcript by content kind (the
 * context surface's composition — characters of the loaded messages, as that
 * surface says), the cache hit rate, and 「压缩」, which runs `/compact` through
 * the composer. The full context pane stays in the title bar's ⋮.
 */
export function ContextCard({ sessionId, view }: { sessionId: string; view: ContextCardView }) {
  const { t } = useI18n();
  const percent = view.percent;
  return (
    <RailCard
      id="context"
      title={t('Context')}
      summary={
        percent === null ? null : (
          <>
            <span>{`${Math.round(percent)}%`}</span>
            <ContextMeter percent={percent} label={t('Context used')} />
          </>
        )
      }
    >
      <ContextCardBody sessionId={sessionId} view={view} />
    </RailCard>
  );
}

function ContextCardBody({ sessionId, view }: { sessionId: string; view: ContextCardView }) {
  const { t } = useI18n();
  const messages = useChatSessionsStore((state) => state.messages[sessionId]) ?? EMPTY_MESSAGES;
  // Mounted only while the card is open, so a folded card measures nothing.
  const composition = useMemo(() => deriveConversationComposition(messages), [messages]);
  const compacting = useCompactRunsStore((state) => selectCompactPhase(state, sessionId) != null);
  return (
    <div className="flex flex-col gap-1.5">
      {view.usedTokens !== null && view.contextWindow !== null && (
        <div className="flex h-5 items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('Context used')}</span>
          <span className="tabular-nums">
            {formatTokenTotal(view.usedTokens)} / {formatTokenTotal(view.contextWindow)}
          </span>
        </div>
      )}
      {composition.buckets.length > 0 && (
        <div className="flex flex-col gap-0.5" data-rail-context-buckets="">
          {composition.buckets.map((bucket) => (
            <div key={bucket.id} className="flex h-5 min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-xs"
                style={{ background: BUCKET_COLOR[bucket.id] }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t(BUCKET_LABEL[bucket.id])}
              </span>
              <span className="shrink-0 tabular-nums">{formatShare(bucket.share)}</span>
            </div>
          ))}
          <p className="text-2xs text-foreground-faint">
            {t('By content, counted in characters of the loaded messages')}
          </p>
        </div>
      )}
      {view.cacheHitRate !== null && (
        <div className="flex h-5 items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('Cache hit rate')}</span>
          <span className="tabular-nums">{`${view.cacheHitRate}%`}</span>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={compacting}
          onClick={() => requestComposerCompact(sessionId)}
          data-rail-compact=""
        >
          {t('Compact')}
        </Button>
      </div>
    </div>
  );
}
