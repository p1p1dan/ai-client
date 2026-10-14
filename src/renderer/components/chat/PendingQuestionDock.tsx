/**
 * F5 — where a live question is answered.
 *
 * ## Why in the composer's place
 *
 * The card is the only thing standing between the user and a turn that cannot
 * continue, so while it waits it IS the input: `PendingInteractionSlot` shows
 * it where the composer was (2026-10-14 user decision). Docked above the
 * composer it covered the timeline the user scrolled back through, and had to
 * be folded by hand to read past it.
 *
 * ## Why the block comes from the store rather than props
 *
 * `question.resolved` is what retires the card, and the worker is what emits
 * it — so a question answered in one window disappears in every other view of
 * the same session. Holding the payload locally would give this dock a second,
 * private copy of that state.
 */

import { useChatSessionsStore } from '../../stores/chatSessions';
import { useSessionPanelsStore } from '../../stores/sessionPanels';
import { requestComposerFocus } from './composerFocus';
import { PlanReviewCard } from './PlanReviewCard';
import { QuestionPrompt } from './QuestionPrompt';
import { deriveQuestionCardState } from './questionCardModel';
import { deriveGoalBarView } from './sessionPanelsModel';

/** Whether this session has a live question card to show in the composer's place. */
export function useHasPendingQuestionCard(sessionId: string | null): boolean {
  return useChatSessionsStore((state) => {
    const pending = state.pendingQuestions.find((item) => item.sessionId === sessionId);
    if (!pending || !sessionId) return false;
    const message = state.messages[sessionId]?.find((item) => item.id === pending.messageId);
    const block = message?.blocks.find(
      (item) => item.type === 'question' && item.questionId === pending.questionId
    );
    return block !== undefined && deriveQuestionCardState(block) === 'pending';
  });
}

export function PendingQuestionDock({ sessionId }: { sessionId: string | null }) {
  // chat-event-01: a turn can park several questions at once, so this takes the
  // OLDEST one still waiting on this session and works the queue in arrival
  // order. Returning the parked entry itself (or the null literal) keeps the
  // selector referentially stable across unrelated store writes.
  const pending = useChatSessionsStore(
    (state) => state.pendingQuestions.find((item) => item.sessionId === sessionId) ?? null
  );
  const block = useChatSessionsStore((state) => {
    if (!pending || !sessionId) return undefined;
    const message = state.messages[sessionId]?.find((item) => item.id === pending.messageId);
    return message?.blocks.find(
      (item) => item.type === 'question' && item.questionId === pending.questionId
    );
  });
  const respondQuestion = useChatSessionsStore((state) => state.respondQuestion);
  // Decision 169: whether a plan review may still set a goal is the goal bar's call.
  const goalPanels = useSessionPanelsStore((state) =>
    sessionId ? state.bySession[sessionId] : undefined
  );

  // `pending` without a block is a real intermediate state, not a bug: the
  // event that docks the question and the one that writes its block are the
  // same reducer pass, but a reload can drop the bucket while the id survives.
  if (!pending || !block) return null;
  // Belt and braces with the store: a card frozen by `question.resolved` must
  // not linger here answerable, whichever of the two updates lands first.
  if (deriveQuestionCardState(block) !== 'pending') return null;

  if (block.planReview) {
    // Decision 169: a plan review is its own card. Keyed by the question, so
    // the next review (a revised plan) starts from the defaults again.
    return (
      <PlanReviewCard
        key={pending.questionId}
        block={block}
        goal={deriveGoalBarView(goalPanels, false)}
        onRespond={(payload) => respondQuestion({ ...payload, questionId: pending.questionId })}
        onClosed={() => {
          if (sessionId) requestComposerFocus(sessionId);
        }}
      />
    );
  }

  return (
    <QuestionPrompt
      // Keyed by the question, so the next parked one starts from a clean card.
      key={pending.questionId}
      block={block}
      // Answer the card that is actually on screen, by id: with more than
      // one question parked, "the first one" is not a stable address.
      onSubmit={(payload) => respondQuestion({ ...payload, questionId: pending.questionId })}
      onChatAbout={(payload) => respondQuestion({ ...payload, questionId: pending.questionId })}
      onSkip={() => respondQuestion({ questionId: pending.questionId, cancel: true })}
    />
  );
}
