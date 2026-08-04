import { useEffect, useState } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { QuestionCard } from './QuestionCard';
import {
  buildSkipPayload,
  deriveQuestionCardState,
  QUESTION_DOCK_WRAPPER_CLASS,
  selectPendingQuestionBlock,
} from './questionCardModel';
import { ReadingColumn } from './ReadingColumn';

interface PendingQuestionDockProps {
  sessionId: string | null;
}

/**
 * T-05 (D-4): live pending-question surface, mounted in `ChatWorkspace`
 * between `MessageTimeline` and the Composer host — outside `ScrollArea`, so
 * it is never scrolled away while a question is pending (A07 :2585).
 *
 * Frozen (answered/skipped) questions render in the timeline itself, in
 * block position — this component only ever shows the live, answerable
 * card, and defers to the store's own `question.resolved` freeze (D20) to
 * decide when it should stop.
 */
export function PendingQuestionDock({ sessionId }: PendingQuestionDockProps) {
  const pendingQuestion = useChatSessionsStore((state) => state.pendingQuestion);
  const block = useChatSessionsStore((state) =>
    selectPendingQuestionBlock(state.messages, state.pendingQuestion, sessionId)
  );
  const respondQuestion = useChatSessionsStore((state) => state.respondQuestion);

  // Default collapsed (A07 screen 6 group A is the resting form); a new
  // question resets it so a just-arrived card doesn't inherit the previous
  // one's expanded state.
  const [collapsed, setCollapsed] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: questionId triggers the reset-to-collapsed on question switch
  useEffect(() => {
    setCollapsed(true);
  }, [pendingQuestion?.questionId]);

  if (!sessionId || !pendingQuestion || pendingQuestion.sessionId !== sessionId || !block) {
    return null;
  }
  if (deriveQuestionCardState(block) !== 'pending') {
    return null;
  }

  return (
    <div className={QUESTION_DOCK_WRAPPER_CLASS}>
      <ReadingColumn>
        <QuestionCard
          key={block.id}
          variant="interactive"
          block={block}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((prev) => !prev)}
          onSubmit={(payload) => respondQuestion(payload)}
          onSkip={() => respondQuestion(buildSkipPayload())}
        />
      </ReadingColumn>
    </div>
  );
}
