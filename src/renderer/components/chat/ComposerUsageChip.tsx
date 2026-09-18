import { deriveCacheHitRate, deriveContextOccupancy, type PiUsagePayload } from '@shared/piUsage';
import { useEffect, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { formatTokenTotal } from './countFormat';

export function currentTurnToolSummary(messages: readonly ChatMessage[]): string {
  const start = messages.findLastIndex((message) => message.role === 'user');
  const counts = new Map<string, number>();
  for (const message of messages.slice(start + 1)) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue;
      const name = block.toolName || 'tool';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => `${name} × ${count}`).join(' · ');
}

export function ComposerUsageDetails({ usage, tools }: { usage: PiUsagePayload; tools: string }) {
  const { t } = useI18n();
  const context = deriveContextOccupancy(usage.context);
  if (!context) return null;
  const cacheRate = deriveCacheHitRate(usage);
  const rows = [
    [t('Input tokens'), formatTokenTotal(usage.input)],
    [t('Output tokens'), formatTokenTotal(usage.output)],
    [t('Cache read'), formatTokenTotal(usage.cacheRead)],
    [t('Cache write'), formatTokenTotal(usage.cacheWrite)],
    [t('Cache hit rate'), cacheRate === null ? t('Not reported') : `${cacheRate}%`],
    [t('Total tokens'), formatTokenTotal(usage.totalTokens)],
  ];
  return (
    <div
      className="w-80 max-w-[calc(100vw-3rem)] space-y-3 py-2 text-ui text-foreground"
      data-context-details
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-meta text-muted-foreground">{t('Context window')}</div>
          <div className="font-semibold">
            {t('{{count}} tokens remaining', { count: formatTokenTotal(context.freeTokens) })}
          </div>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-title font-semibold">{Math.round(100 - context.percent)}%</div>
          <div className="text-meta text-muted-foreground">{t('Remaining')}</div>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between gap-2 text-meta">
          <span>{t('Context used')}</span>
          <span className="tabular-nums">
            {formatTokenTotal(context.usedTokens)} / {formatTokenTotal(context.contextWindow)} ·{' '}
            {Math.round(context.percent)}%
          </span>
        </div>
        <div
          role="meter"
          aria-label={t('Context used')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={context.percent}
          className="h-1.5 overflow-hidden rounded-full bg-input"
        >
          <div className="h-full bg-status-running" style={{ width: `${context.percent}%` }} />
        </div>
      </div>
      <div className="border-t border-border pt-2">
        <p className="mb-2 text-meta font-medium">{t('Latest settled model request')}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-meta">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 justify-between gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="shrink-0 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {usage.session && (
        <div className="flex justify-between gap-2 border-t border-border pt-2 text-meta">
          <span>{t('Conversation total since load')}</span>
          <span className="shrink-0 tabular-nums">
            {formatTokenTotal(usage.session.totalTokens)} tokens · {usage.session.turns}{' '}
            {t('model requests')}
          </span>
        </div>
      )}
      <div className="space-y-1 border-t border-border pt-2 text-meta">
        <p className="font-medium">{t('Tools in current turn')}</p>
        <p className="break-words text-muted-foreground">
          {tools || t('No tool calls in this turn')}
        </p>
        <p className="text-muted-foreground">
          {t(
            'Tool token usage, reasoning tokens and generation speed are not reported with comparable measurements.'
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The compact occupancy chip in the composer bar.
 *
 * It is a BUTTON, not a hover target: the details below are a dense read
 * (six token rows, a meter, the turn's tools) that a reader has to be able to
 * keep open while scanning, and a tooltip took them away the moment the
 * pointer moved. Click opens, clicking the chip again — or anywhere outside,
 * or Escape — closes, which is what the Popover primitive already does.
 */
export function ComposerUsageChip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const usage = useSessionRuntimeFactsStore(
    (state) => state.factsBySession[sessionId]?.usage ?? null
  );
  const messages = useChatSessionsStore((state) => state.messages[sessionId]);
  const [open, setOpen] = useState(false);
  // A session switch must not leave another session's numbers on screen: the
  // chip itself re-renders with the new facts, but an open popup would keep
  // its position and simply swap its contents under the reader.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset TRIGGER, not a value the body reads
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);
  const occupancy = deriveContextOccupancy(usage?.context);
  if (!usage || !occupancy) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t('Context used')}
        title={t('Context used')}
        className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-sm px-1.5 text-sm text-muted-foreground tabular-nums hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-hover data-popup-open:text-foreground"
      >
        {`${Math.round(occupancy.percent)}%`}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        className="max-h-[min(75vh,32rem)] text-left"
        zIndex={Z_INDEX.DROPDOWN}
      >
        <ComposerUsageDetails usage={usage} tools={currentTurnToolSummary(messages ?? [])} />
      </PopoverPopup>
    </Popover>
  );
}
