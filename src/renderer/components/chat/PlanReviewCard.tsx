import type { PlanReviewChoice } from '@shared/planReview';
import { ClipboardList, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DockCard,
  DockCardBody,
  DockCardFooter,
  DockCardHeader,
  DockCardTitle,
} from '@/components/ui/dock-card';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { StatusIcon } from '@/components/ui/status-icon';
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
  planReviewBody,
  planReviewOptionRows,
  planReviewSubmit,
  SDK_PLAN_REVIEW_BYPASS_CONFIRM,
  SDK_PLAN_REVIEW_BYPASS_WARNING,
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
  // Route B, S-2: the Claude Agent SDK engine names its own choices (no goals).
  const offered = card?.choices;
  const [choice, setChoice] = useState<PlanReviewChoice>(() =>
    defaultPlanReviewChoice(goal, offered)
  );
  const [feedback, setFeedback] = useState('');
  const [confirmingBypass, setConfirmingBypass] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  // A goal the goal bar shows while the card is up (or one cleared) moves the choices.
  const effective = availablePlanReviewChoice(choice, goal, offered);
  useEffect(() => {
    if (effective !== choice) setChoice(effective);
  }, [effective, choice]);

  if (!card) return null;
  const rows = planReviewOptionRows(goal, offered);
  const ownChoices = offered !== undefined && offered.length > 0;
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
    // In the composer's slot. S-6 feedback 8: the plan was squeezed to a line or two
    // under a 40% cap shared with every choice. Now the card may take 70% of the window,
    // the choices keep a fixed share and the buttons stay at the bottom, and the plan gets
    // the rest; the whole plan also opens in a larger window.
    // Design system v2 §7.6: the shared dock card. Waiting on the user, so
    // `pending`; while full auto is being confirmed the edge turns `risk`.
    <DockCard
      tone={confirmingBypass ? 'risk' : 'pending'}
      className="max-h-[70vh] min-h-0"
      role="region"
      aria-label={t(title)}
      data-testid="plan-review-card"
      data-source={card.source}
    >
      <DockCardHeader>
        <StatusIcon status="waiting" />
        <DockCardTitle className="flex-none">{t(title)}</DockCardTitle>
        {card.title && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={card.title}>
            {card.title}
          </span>
        )}
      </DockCardHeader>
      <DockCardBody className="flex min-h-0 flex-1 flex-col gap-2 pb-2 text-foreground">
        {/* The plan scrolls between two hairlines, no frame of its own
            (§1 rule 1: one closed border along any line of sight). */}
        <div
          className="-mx-4 min-h-24 flex-1 overflow-y-auto border-border-soft border-y px-4 py-2"
          data-testid="plan-review-body"
        >
          <p className="select-text whitespace-pre-wrap break-words text-ui text-foreground">
            {body.markdown}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className="-ml-2"
            onClick={() => setViewerOpen(true)}
          >
            {t('Open the whole plan in a larger window')}
          </Button>
        </div>
        <div
          className="flex max-h-[30vh] shrink-0 flex-col gap-2 overflow-y-auto"
          data-testid="plan-review-choices"
        >
          {card.source === 'exit_plan_mode' && !ownChoices && (
            <div className="flex min-w-0 flex-col gap-0.5 text-small">
              <span className="text-muted-foreground">{t('Goal it would set')}</span>
              <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words text-foreground">
                {card.goalObjective}
              </span>
            </div>
          )}
          {confirmingBypass ? (
            // No inner frame (§1 rule 1): the card's own edge turns `risk`, and
            // only the icon is red (§1 rule 5).
            <div role="alert" className="flex flex-col gap-2">
              <p className="flex items-start gap-2 text-ui text-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                {t(ownChoices ? SDK_PLAN_REVIEW_BYPASS_WARNING : PLAN_REVIEW_BYPASS_WARNING)}
              </p>
              <div className="flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={submitting}
                  onClick={() => setConfirmingBypass(false)}
                >
                  {t(PLAN_REVIEW_BACK)}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  type="button"
                  disabled={submitting}
                  onClick={() => void confirm(true)}
                >
                  {t(ownChoices ? SDK_PLAN_REVIEW_BYPASS_CONFIRM : PLAN_REVIEW_BYPASS_CONFIRM)}
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
                          className="text-small text-muted-foreground"
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
                  <label htmlFor={`${id}-feedback`} className="text-small text-muted-foreground">
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
            <p role="alert" className="text-small text-destructive">
              {t('Could not send your answer. Please try again.')}
            </p>
          )}
        </div>
      </DockCardBody>
      {!confirmingBypass && (
        <DockCardFooter className="flex-wrap">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={submitting}
            onClick={() => void close()}
          >
            {t(PLAN_REVIEW_CLOSE)}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={submitting || (effective === 'keep-planning' && feedback.trim() === '')}
            onClick={() => void confirm(false)}
          >
            {submitting ? t('Submitting…') : t(PLAN_REVIEW_CONFIRM)}
          </Button>
        </DockCardFooter>
      )}
      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogPopup className="max-w-3xl" data-testid="plan-review-viewer">
          <DialogHeader>
            <DialogTitle>{card.title || t(title)}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="select-text whitespace-pre-wrap break-words text-ui text-foreground">
              {body.markdown}
            </p>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </DockCard>
  );
}

/** The settled review in the timeline: one line, what was chosen, and why a goal is missing. */
export function FrozenPlanReview({ block }: { block: ChatBlock }) {
  const { t } = useI18n();
  const line = frozenPlanReviewLine(block);
  const note = frozenPlanReviewGoalNote(block);
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 text-small text-muted-foreground"
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
