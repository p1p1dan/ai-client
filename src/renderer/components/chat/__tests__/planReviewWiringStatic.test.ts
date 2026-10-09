import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * dsh-rebase decision 169: where the plan review is wired into the window.
 * `ChatComposer` cannot be rendered in this suite (see `retryLastTurn.test.ts`),
 * so the call sites are pinned by source scan; what the called functions do
 * is `planReviewModel.test.ts`'s and `planReviewCard.test.ts`'s.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  stripComments(readFileSync(path.resolve(here, file), 'utf8'), path.basename(file));

const COMPOSER = read('../ChatComposer.tsx');
const HANDLE_SEND = COMPOSER.slice(
  COMPOSER.indexOf('const handleSend = async'),
  COMPOSER.indexOf('const closePendingPlanReview = async')
);
const CLOSE = COMPOSER.slice(
  COMPOSER.indexOf('const closePendingPlanReview = async'),
  COMPOSER.indexOf('const interjectIntoTurn = async')
);

describe('[decision 169] a message sent while the review is up closes it first', () => {
  it('handleSend closes the review before steering (Ctrl+Enter) or queueing (Enter)', () => {
    const close = HANDLE_SEND.indexOf('await closePendingPlanReview(activeSessionId)');
    expect(close).toBeGreaterThan(0);
    expect(close).toBeLessThan(HANDLE_SEND.indexOf("if (mode === 'interject')"));
    expect(close).toBeLessThan(HANDLE_SEND.indexOf('.enqueue(queued)'));
    // After the action gate: a blocked or local send closes nothing.
    expect(close).toBeGreaterThan(HANDLE_SEND.indexOf("if (action === 'send')"));
  });

  it('answers only this chat’s plan review, with a cancel', () => {
    expect(CLOSE).toContain('pendingPlanReviewId(store, sessionId)');
    expect(CLOSE).toContain('respondQuestion({ questionId, cancel: true })');
  });

  it('the message box takes the keyboard when the review is closed', () => {
    expect(COMPOSER).toContain('onComposerFocusRequest(');
    const dock = read('../PendingQuestionDock.tsx');
    expect(dock).toContain('block.planReview');
    expect(dock).toContain('<PlanReviewCard');
    expect(dock).toContain('requestComposerFocus(sessionId)');
  });
});

describe('[decision 169] a settled review and the posture it switched', () => {
  it('the timeline draws a settled review as its frozen line', () => {
    const timeline = read('../MessageTimeline.tsx');
    expect(timeline).toContain('if (item.block.planReview) return <FrozenPlanReview');
  });

  it('the window stores the posture an approval switched, for every chat', () => {
    const app = read('../../../App.tsx');
    expect(app).toContain('startPlanApprovalPostureWatch(');
    expect(app).toContain('writeSessionPermissions,');
    expect(app).toContain('notePostureSynced(sessionId)');
  });
});
