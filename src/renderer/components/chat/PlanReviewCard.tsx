import type { PlanReviewChoice } from '@shared/planReview';
import { ChevronDown, ChevronUp, ClipboardList, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  availablePlanReviewChoice,
  defaultPlanReviewChoice,
  frozenPlanReviewGoalNote,
  frozenPlanReviewLine,
  PLAN_REVIEW_BACK,
  PLAN_REVIEW_BYPASS_CONFIRM,
  PLAN_REVIEW_BYPASS_WARNING,
  PLAN_REVIEW_CLOSE,
  PLAN_REVIEW_CONFIRM,
  PLAN_REVIEW_FEEDBACK_LABEL,
  PLAN_REVIEW_FEEDBACK_REQUIRED,
  PLAN_REVIEW_GOAL_TITLE,
  PLAN_REVIEW_TITLE,
  planPreviewClass,
  planReviewBody,
  planReviewOptionRows,
  planReviewSubmit,
} from './planReviewModel';
import type { GoalBarView } from './sessionPanelsModel';

/**
 * dsh-rebase decision 169: the plan review card. In the dock (`interactive`)
 * it shows the plan — a few lines, opened in place on demand, so the card
 * fits an 800 px window; as written, the way the question card shows its
 * text and the `exit_plan_mode` row its plan, since assistant prose is
 * Markdown in one place only (T-29) — the goal an approval would set, and the four ways
 * on; 「完全放行」 is confirmed once more in place (decision 023), 「继续讨论
 * 修改」 takes what should change. Closing it hands the keyboard to the
 * message box: the model stops and waits for what the user types. Frozen in
 * the timeline it is one line saying what was chosen.
 *
 * The choices are `planReviewModel.ts`'s; this file only draws them.
 */

const SHELL_CLASS = 'overflow-hidden rounded-md border border-border bg-card';

interface InteractiveProps {
  block: ChatBlock;
  /** The goal bar's view of this chat: an unfinished goal turns the goal choices off. */
  goal: GoalBarView | null;
  /** Answers the card; `false` (IPC failure) unlocks it again. */
  onRespond: (
    payload: { answers: Record<string, string>; response?: string } | { cancel: true }
  ) => Promise<boolean> | undefined;
  /** After the review is closed: the message box takes the keyboard. */
  onClosed?: () => void;
}

export function PlanReviewCard({ block, goal, onRespond, onClosed }: InteractiveProps) {
  const { t } = useI18n();
  const id = useId();
  const card = block.planReview;
  const [choice, setChoice] = useState<PlanReviewChoice>(() => defaultPlanReviewChoice(goal));
  const [feedback, setFeedback] = useState('');
  const [confirmingBypass, setConfirmingBypass] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  // A goal the goal bar shows while the card is up (or one cleared) moves the choices.
  const effective = availablePlanReviewChoice(choice, goal);
  useEffect(() => {
    if (effective !== choice) setChoice(effective);
  }, [effective, choice]);

  if (!card) return null;
  const rows = planReviewOptionRows(goal);
  const body = planReviewBody(card);
  const title = card.source === 'create_goal' ? PLAN_REVIEW_GOAL_TITLE : PLAN_REVIEW_TITLE;

  const send = async (
    payload: { answers: Record<string, string>; response?: string } | { cancel: true }
  ) => {
    setSubmitting(true);
    setFailed(false);
    const ok = await onRespond(payload);
    if (ok === false) {
      setSubmitting(false);
      setFailed(true);
      return false;
    }
    return true;
  };

  const confirm = async (confirmedBypass: boolean) => {
    const next = planReviewSubmit(effective, feedback, confirmedBypass);
    if (next.kind === 'confirm-bypass') {
      setConfirmingBypass(true);
      return;
    }
    // Keep planning with nothing to say is not offered (the button is off):
    // DSH would present the same plan again at once.
    if (next.kind === 'feedback-required') return;
    await send(next.payload);
  };

  const close = async () => {
    if (await send({ cancel: true })) onClosed?.();
  };

  return (
    <section
      className={SHELL_CLASS}
      aria-label={t(title)}
      data-testid="plan-review-card"
      data-source={card.source}
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-2 text-muted-foreground">
        <ClipboardList className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-semibold">{t(title)}</span>
        {card.title && (
          <span className="min-w-0 flex-1 truncate text-foreground" title={card.title}>
            {card.title}
          </span>
        )}
        <button
          type="button"
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-sm hover:bg-hover"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('Expand the plan review') : t('Collapse the plan review')}
        >
          {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-2 p-2.5">
          <div
            className={cn(
              'overflow-y-auto rounded-sm border border-border bg-background px-2.5 py-1.5',
              planPreviewClass(expanded)
            )}
            data-testid="plan-review-body"
          >
            <p className="select-text whitespace-pre-wrap break-words text-ui text-foreground">
              {body.markdown}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="h-6 px-2 text-muted-foreground"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('Show less of the plan') : t('Show the whole plan')}
            </Button>
          </div>
          {card.source === 'exit_plan_mode' && (
            <div className="flex min-w-0 flex-col gap-0.5 text-meta">
              <span className="text-muted-foreground">{t('Goal it would set')}</span>
              <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words text-foreground">
                {card.goalObjective}
              </span>
            </div>
          )}
          {confirmingBypass ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-sm border border-destructive/40 bg-destructive/5 p-2.5"
            >
              <p className="flex items-start gap-2 text-ui text-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                {t(PLAN_REVIEW_BYPASS_WARNING)}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  className="h-6 px-2"
                  disabled={submitting}
                  onClick={() => setConfirmingBypass(false)}
                >
                  {t(PLAN_REVIEW_BACK)}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  type="button"
                  className="h-6 px-2"
                  disabled={submitting}
                  onClick={() => void confirm(true)}
                >
                  {t(PLAN_REVIEW_BYPASS_CONFIRM)}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <RadioGroup
                value={effective}
                onValueChange={(value) => setChoice(value as PlanReviewChoice)}
                aria-label={t('After approval')}
                className="gap-2"
                disabled={submitting}
              >
                {rows.map((row) => {
                  const radioId = `${id}-${row.id}`;
                  return (
                    <div key={row.id} className="flex items-start gap-2" data-choice={row.id}>
                      <Radio
                        id={radioId}
                        value={row.id}
                        disabled={row.disabled || submitting}
                        aria-describedby={`${radioId}-description`}
                        className="mt-0.5"
                      />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <label
                          htmlFor={radioId}
                          className={cn(
                            'text-ui text-foreground',
                            row.disabled && 'text-muted-foreground'
                          )}
                        >
                          {t(row.label)}
                        </label>
                        <span
                          id={`${radioId}-description`}
                          className="text-meta text-muted-foreground"
                        >
                          {t(row.hint ?? row.description)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </RadioGroup>
              {effective === 'keep-planning' && (
                <div className="flex flex-col gap-1 pl-6">
                  <label htmlFor={`${id}-feedback`} className="text-meta text-muted-foreground">
                    {t(PLAN_REVIEW_FEEDBACK_LABEL)}
                  </label>
                  <Textarea
                    id={`${id}-feedback`}
                    size="sm"
                    value={feedback}
                    disabled={submitting}
                    placeholder={t(PLAN_REVIEW_FEEDBACK_REQUIRED)}
                    onChange={(event) => setFeedback(event.target.value)}
                  />
                </div>
              )}
            </>
          )}
          {failed && (
            <p role="alert" className="text-meta text-destructive">
              {t('Could not send your answer. Please try again.')}
            </p>
          )}
          {!confirmingBypass && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                className="mr-auto h-6 px-2 text-muted-foreground"
                disabled={submitting}
                onClick={() => void close()}
              >
                {t(PLAN_REVIEW_CLOSE)}
              </Button>
              <Button
                size="sm"
                type="button"
                className="h-6 px-2.5"
                disabled={submitting || (effective === 'keep-planning' && feedback.trim() === '')}
                onClick={() => void confirm(false)}
              >
                {submitting ? t('Submitting…') : t(PLAN_REVIEW_CONFIRM)}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The settled review in the timeline: one line, what was chosen, and why a goal is missing. */
export function FrozenPlanReview({ block }: { block: ChatBlock }) {
  const { t } = useI18n();
  const line = frozenPlanReviewLine(block);
  const note = frozenPlanReviewGoalNote(block);
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 text-meta text-muted-foreground"
      data-testid="plan-review-frozen"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ClipboardList className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t(line.key, line.params)}</span>
      </div>
      {note && <span className="pl-6">{t(note.key, note.params)}</span>}
    </div>
  );
}
