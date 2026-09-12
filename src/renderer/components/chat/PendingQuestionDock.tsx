/**
 * F5 — where a live question is answered.
 *
 * `MessageTimeline` has said for a long time that "the live, answerable card
 * lives in `PendingQuestionDock` (outside ScrollArea, docked above the
 * Composer)" and then rendered only the frozen copy, because no such component
 * existed and nothing ever produced a `question.requested` to put in it. The
 * runtime's `ask` tool is that producer; this is that dock.
 *
 * ## Why outside the scroll area
 *
 * The card is the only thing standing between the user and a turn that cannot
 * continue. In the timeline it scrolls away as the assistant keeps streaming,
 * and the session sits in `waiting_question` with the reason off screen. Docked
 * above the composer it stays where the composer's own hint already points.
 *
 * ## Why the block comes from the store rather than props
 *
 * `question.resolved` is what retires the card, and the worker is what emits
 * it — so a question answered in one window disappears in every other view of
 * the same session. Holding the payload locally would give this dock a second,
 * private copy of that state.
 */

import { useState } from 'react';
import { useChatSessionsStore } from '../../stores/chatSessions';
import { QuestionCard } from './QuestionCard';
import { deriveQuestionCardState } from './questionCardModel';

export function PendingQuestionDock({ sessionId }: { sessionId: string | null }) {
  const pending = useChatSessionsStore((state) =>
    state.pendingQuestion?.sessionId === sessionId ? state.pendingQuestion : null
  );
  const block = useChatSessionsStore((state) => {
    if (!pending || !sessionId) return undefined;
    const message = state.messages[sessionId]?.find((item) => item.id === pending.messageId);
    return message?.blocks.find(
      (item) => item.type === 'question' && item.questionId === pending.questionId
    );
  });
  const respondQuestion = useChatSessionsStore((state) => state.respondQuestion);
  const [collapsed, setCollapsed] = useState(false);

  // `pending` without a block is a real intermediate state, not a bug: the
  // event that docks the question and the one that writes its block are the
  // same reducer pass, but a reload can drop the bucket while the id survives.
  if (!pending || !block) return null;
  // Belt and braces with the store: a card frozen by `question.resolved` must
  // not linger here answerable, whichever of the two updates lands first.
  if (deriveQuestionCardState(block) !== 'pending') return null;

  return (
    <div className="min-w-0 shrink-0 px-2 pb-2 sm:px-6">
      <div className="mx-auto w-full max-w-reading">
        <QuestionCard
          variant="interactive"
          block={block}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          onSubmit={(payload) => respondQuestion(payload)}
          onSkip={() => respondQuestion({ cancel: true })}
        />
      </div>
    </div>
  );
}
