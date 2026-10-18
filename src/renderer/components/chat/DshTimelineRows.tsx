/**
 * dsh-rebase P1-7a: the two light rows of a DSH timeline — the head of a turn
 * the engine started by itself (`AutoTurnHead`) and a notice in the middle of
 * a turn (`DshNoticeRow`). What each shows is `dshTimelineRowModel.ts`'s; the look
 * is the P1-7 prototype's `.autohead` (scene B): the meta size, muted, an
 * icon, the words, a hairline rule, the time — no bubble, no Alert box.
 */

import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  CircleX,
  Info,
  Layers,
  SquareSlash,
  Target,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chatSessions';
import { useCompactRunsStore } from '@/stores/compactRuns';
import { userBubbleClass, userBubbleRowClass, userBubbleTextClass } from './chatTimelineLayout';
import {
  type AutoTurnHeadView,
  autoTurnHeadView,
  compactingClockLine,
  type DshCompactCommandRowView,
  type DshCompactionRowView,
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
    case 'scheduled':
      return t('A scheduled task came due, carrying on');
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
    case 'scheduled':
      return <AlarmClock className={className} aria-hidden />;
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
  if (view.warning) {
    // User 2026-10-18: something to act on (a model's real window is smaller
    // than its setting), so the whole sentence shows, not one truncated line.
    return (
      <div
        className="flex min-w-0 items-start gap-2 text-meta text-muted-foreground"
        data-testid="dsh-notice-row"
        data-kind={view.kind}
        data-warning="true"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">
          {view.translatable ? t(view.text, view.params) : view.text}
        </p>
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
            title={view.translatable ? t(view.text, view.params) : view.text}
          >
            {view.translatable ? t(view.text, view.params) : view.text}
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

/**
 * dsh-rebase decision 178: an automatic compaction where it runs — a spinner
 * and "Compacting the context…" while it runs, then the context-summary row in
 * its place; or one line saying it did not succeed, with an info icon like any
 * other notice.
 *
 * Decision 180: a `/compact` the user ran is drawn the same way. While this
 * window's own runs, the line carries its clock (「正在压缩上下文… 12 秒」) and
 * how to cut it short (「按 Esc 取消」, then 「正在取消…」).
 */
export function DshCompactionRow({
  view,
  sessionId,
}: {
  view: DshCompactionRowView;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const run = useCompactRunsStore((state) =>
    sessionId && view.running && state.phases[sessionId] !== undefined
      ? `${state.phases[sessionId]}:${state.compactingSince[sessionId] ?? ''}:${
          state.cancelling[sessionId] ? 'cancelling' : ''
        }`
      : null
  );
  const [phase, since, cancelling] = run?.split(':') ?? [];
  const startedAt = since ? Number(since) : undefined;
  const now = useSecondClock(startedAt !== undefined);
  const words =
    phase === 'compacting' && startedAt !== undefined
      ? (() => {
          const line = compactingClockLine((now - startedAt) / 1000);
          return t(line.key, line.params);
        })()
      : t(view.key, view.params);
  const hint = run ? t(cancelling ? 'Cancelling…' : 'Esc to cancel') : null;
  return (
    <div
      className={dshLightRowClass()}
      data-testid="dsh-compaction-row"
      data-state={view.running ? 'running' : 'settled'}
      role={view.running ? 'status' : undefined}
    >
      {view.running ? (
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Info className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate tabular-nums" title={words}>
        {words}
      </span>
      {hint && (
        <span className="shrink-0" data-testid="dsh-compaction-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** The time, once a second while `on`. */
function useSecondClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * Decision 180: a `/compact`'s command line — what the user typed, as the
 * user's own line is drawn (the bubble of `MessageTimeline`'s `UserBubble`).
 * It is no prompt: it opens no turn, and the prompt rail does not list it.
 */
export function DshCompactCommandRow({ view }: { view: DshCompactCommandRowView }) {
  return (
    <article className={userBubbleRowClass()} data-testid="compact-command-row">
      <div className={userBubbleClass()}>
        <div className={userBubbleTextClass()}>
          <p className="whitespace-pre-wrap break-words text-chat-body leading-relaxed text-foreground">
            {view.text}
          </p>
        </div>
      </div>
    </article>
  );
}
