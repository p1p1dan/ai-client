/**
 * Issue #9 (decision 173 §4.5): the Run panel's 「逐步缓存」 group and the
 * session's cache alert, laid out as the approved prototype draws them
 * (`docs/plantree/plans/dsh-rebase/evidence/cache-chain-2026-10/`). Every value
 * comes from `runPanelModel.ts`'s `deriveRunCacheView`; these components only
 * place it and hold the view state (open / closed, older rows, 「已复制」).
 */
import { Check, ChevronRight, Copy, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatTokenTotal } from '@/components/chat/countFormat';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useRunPanelPreferencesStore } from '@/stores/runPanelPreferences';
import {
  foldCacheRows,
  type RunCacheAlertView,
  type RunCacheBadge,
  type RunCacheGroupView,
  type RunCacheRow,
  resolveCacheGroupOpen,
} from './runPanelModel';

/** How long the copy button reads 「已复制」 (as `ErrorBoundary` and `MessageTimeline`). */
const COPY_CONFIRM_MS = 1500;

/**
 * The session alert: first in the panel's scroll root. The copy button sits in
 * the description under the sentence, not in `AlertAction`, which would give
 * it a column of its own and leave the sentence a hundred pixels at 280 wide.
 * The close button does take that column: it is one icon.
 */
export function RunCacheAlert({
  alert,
  diagnostics,
  onDismiss,
}: {
  alert: RunCacheAlertView;
  /** Built when the button is pressed, so it carries the numbers of that moment. */
  diagnostics: () => string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics());
    } catch {
      // A button that claims 「已复制」 after a refused write is worse than none.
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

  return (
    <div className="shrink-0 border-b p-2" data-cache-alert="">
      <Alert variant="warning">
        <TriangleAlert />
        <AlertTitle>{alert.title}</AlertTitle>
        <AlertDescription>
          <p>{alert.body}</p>
          <div>
            <Button
              size="xs"
              variant="outline"
              className="h-6 sm:text-meta"
              onClick={() => void handleCopy()}
              data-cache-copy=""
            >
              {copied ? <Check /> : <Copy />}
              {copied ? t('Copied') : t('Copy diagnostics')}
            </Button>
          </div>
        </AlertDescription>
        <AlertAction className="sm:self-start">
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 text-muted-foreground"
            aria-label={t('Hide for this chat')}
            title={t('Hide for this chat')}
            onClick={onDismiss}
            data-cache-alert-dismiss=""
          >
            <X className="size-3.5" />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

function CacheStepBadge({ badge }: { badge: RunCacheBadge }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={badge.tone}
            size="lg"
            tabIndex={0}
            className="min-w-0 max-w-full shrink"
            data-cache-badge={badge.tone}
          />
        }
      >
        <span className="truncate">{badge.text}</span>
      </TooltipTrigger>
      {/* Decision 174: 14px — the sentences are CJK, and coss's popup is 12px. */}
      <TooltipPopup className="max-w-66 text-meta">
        <div className="flex flex-col gap-1" data-cache-tip="">
          {badge.tips.map((tip) => (
            <p key={tip}>{tip}</p>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One step. Under 28rem of group width the badge wraps below the numbers,
 * indented past the step column; from 28rem (`@md:`) it sits between them.
 */
function CacheStepRow({ row }: { row: RunCacheRow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 px-1" data-cache-step={row.step}>
      <span className="flex h-7 w-8 shrink-0 items-center justify-end text-meta text-muted-foreground tabular-nums">
        {row.step}
      </span>
      {row.badge && (
        <div className="order-last flex min-w-0 basis-full pb-1 pl-10 @md:order-none @md:h-7 @md:flex-1 @md:items-center @md:pb-0 @md:pl-0">
          <CacheStepBadge badge={row.badge} />
        </div>
      )}
      <span
        className="ml-auto flex h-7 shrink-0 items-center gap-2 text-meta tabular-nums"
        title={row.title}
      >
        <span className="w-12 text-right">{formatTokenTotal(row.prompt)}</span>
        <span className="w-12 text-right">{formatTokenTotal(row.read)}</span>
        <span className={cn('w-12 text-right', row.warning && 'text-warning')}>
          {formatTokenTotal(row.write)}
        </span>
      </span>
    </div>
  );
}

/**
 * The group, between the last step's usage rows and the session's. Closed by
 * default unless the turn has a step nothing local explains; once the user
 * opens or closes it, that choice holds everywhere (`runPanelPreferences`).
 * Mounted per chat (`key`), so 「查看更早的 N 步」 does not carry over.
 */
export function RunCacheStepsGroup({ group }: { group: RunCacheGroupView }) {
  const { t } = useI18n();
  const preference = useRunPanelPreferencesStore((state) => state.cacheStepsGroup);
  const setGroupOpen = useRunPanelPreferencesStore((state) => state.setCacheStepsGroupOpen);
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  const open = resolveCacheGroupOpen(preference, group.anomalies);
  const { shown, hidden } = foldCacheRows(
    group.rows,
    group.turn !== null && expandedTurn === group.turn
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setGroupOpen(next)}
      className="@container mt-1 flex flex-col border-t pt-1"
      data-cache-steps=""
    >
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-1 rounded-sm px-1 text-left hover:bg-hover focus-visible:bg-hover">
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
        <span className="shrink-0 text-ui">{t('Cache by step')}</span>
        {/* No tooltip here: the trigger is a button, and a focusable badge
            inside it would be a control nested in a control. */}
        {group.anomalies > 0 && (
          <Badge variant="warning" size="lg" className="tabular-nums">
            {t('{{count}} anomalies', { count: group.anomalies })}
          </Badge>
        )}
        <span className="ml-auto min-w-0 truncate pl-2 text-meta text-muted-foreground tabular-nums">
          {group.summary}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {group.rows.length === 0 ? (
          group.note && <p className="px-1 py-1 text-meta text-muted-foreground">{group.note}</p>
        ) : (
          <>
            <div className="flex h-6 items-center gap-2 px-1 text-meta text-muted-foreground">
              <span className="w-8 shrink-0 text-right">{t('Step')}</span>
              <span className="ml-auto flex shrink-0 gap-2">
                <span className="w-12 text-right">{t('Prompt')}</span>
                <span className="w-12 text-right">{t('Reused')}</span>
                <span className="w-12 text-right">{t('Written')}</span>
              </span>
            </div>
            {hidden > 0 && (
              <button
                type="button"
                className="flex h-6 w-full items-center rounded-sm px-1 text-left text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"
                onClick={() => setExpandedTurn(group.turn)}
                data-cache-earlier=""
              >
                {t('Show {{count}} earlier steps', { count: hidden })}
              </button>
            )}
            {shown.map((row) => (
              <CacheStepRow key={row.step} row={row} />
            ))}
            {group.note && (
              <p className="px-1 py-1 text-meta text-muted-foreground">{group.note}</p>
            )}
          </>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
