/**
 * dsh-rebase P1-7a: the two light rows of a DSH timeline — the head of a turn
 * the engine started by itself (`AutoTurnHead`) and a notice in the middle of
 * a turn (`DshNoticeRow`). What each shows is `dshTimelineRowModel.ts`'s; the look
 * is the P1-7 prototype's `.autohead` (scene B): the meta size, muted, an
 * icon, the words, a hairline rule, the time — no bubble, no Alert box.
 */

import {
  ChevronDown,
  ChevronRight,
  CircleX,
  Info,
  Layers,
  SquareSlash,
  Target,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chatSessions';
import {
  type AutoTurnHeadView,
  autoTurnHeadView,
  type DshNoticeRowView,
} from './dshTimelineRowModel';
import { formatAbsoluteTime } from './messageMetadata';

/** The row both share: the meta size, muted (prototype `.autohead`). */
export function dshLightRowClass(): string {
  return 'flex min-w-0 items-center gap-2 text-meta text-muted-foreground';
}

/** What a head says, before DSH's own account of it. */
export function autoTurnHeadLabel(view: AutoTurnHeadView, t: TFunction): string {
  const origin = view.origin;
  switch (origin.kind) {
    case 'goal':
      return origin.maxRounds !== undefined
        ? t('Goal · round {{round}}/{{max}}', { round: origin.round, max: origin.maxRounds })
        : t('Goal · round {{round}}', { round: origin.round });
    case 'job':
      return t('A background task finished, carrying on');
    case 'subagent':
      return t('A subagent finished, carrying on');
    case 'agent-message':
      return t('A subagent sent a message');
    default:
      return '';
  }
}

function HeadIcon({ view }: { view: AutoTurnHeadView }) {
  const className = 'size-3.5 shrink-0';
  switch (view.origin.kind) {
    case 'goal':
      return <Target className={className} aria-hidden />;
    case 'job':
      return <Layers className={className} aria-hidden />;
    default:
      return <Users className={className} aria-hidden />;
  }
}

/**
 * The head of a turn nobody sent: 「◎ 目标 · 第 3/256 轮 ──── 12:05」. It opens
 * the turn as a prompt does (the clock and the work group count per round),
 * and the prompt rail skips it — there is nothing typed to jump back to.
 */
export function AutoTurnHead({
  message,
  startedAt,
}: {
  message: ChatMessage;
  startedAt: number | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const view = autoTurnHeadView(message);
  if (!view) return null;
  const label = autoTurnHeadLabel(view, t);
  const words = (
    <span className="min-w-0 truncate" title={view.detail || undefined}>
      {label}
      {view.detail && ` · ${view.detail}`}
    </span>
  );
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="auto-turn-head"
      data-origin={view.origin.kind}
    >
      <div className={dshLightRowClass()}>
        <HeadIcon view={view} />
        {view.expandable ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-xs text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {words}
            {open ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            )}
          </button>
        ) : (
          words
        )}
        <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
        {startedAt !== null && (
          <span className="shrink-0 tabular-nums">{formatAbsoluteTime(startedAt)}</span>
        )}
      </div>
      {view.expandable && open && (
        <p className="select-text whitespace-pre-wrap break-words pl-5.5 text-meta text-muted-foreground">
          {view.detail}
        </p>
      )}
    </div>
  );
}

/**
 * A notice in the middle of a turn: 「(i) 后台任务 … 已结束」, one line of
 * DSH's own account; a longer one (a subagent's message) opens in place. A
 * command's answer is drawn whole, since the user asked for it.
 */
export function DshNoticeRow({ view }: { view: DshNoticeRowView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (view.kind !== 'notice') {
    const failed = view.kind === 'command-error';
    return (
      <div
        className="flex min-w-0 items-start gap-2 text-meta text-muted-foreground"
        data-testid="dsh-notice-row"
        data-kind={view.kind}
      >
        {failed ? (
          <CircleX
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
            aria-label={t('Command failed')}
          />
        ) : (
          <SquareSlash className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        )}
        <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">{view.text}</p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="dsh-notice-row" data-kind={view.kind}>
      <div className={dshLightRowClass()}>
        <Info className="size-3.5 shrink-0" aria-hidden />
        {view.expandable ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-xs text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={cn('min-w-0', !open && 'truncate')}>
              {open ? t('Hide the full text') : view.text.split('\n', 1)[0]}
            </span>
            {open ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            )}
          </button>
        ) : (
          <span
            className="min-w-0 flex-1 select-text truncate"
            title={view.translatable ? t(view.text) : view.text}
          >
            {view.translatable ? t(view.text) : view.text}
          </span>
        )}
      </div>
      {view.expandable && open && (
        <p className="select-text whitespace-pre-wrap break-words pl-5.5 text-meta text-muted-foreground">
          {view.text}
        </p>
      )}
    </div>
  );
}
