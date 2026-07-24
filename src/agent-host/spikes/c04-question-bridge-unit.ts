/**
 * C-04 unit smoke: QuestionBridge park/respond/cancel/abort semantics.
 * No SDK, no network — drives the bridge directly like the SDK would.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c04-question-bridge-unit.ts
 */

import { QuestionBridge } from '../questionBridge.ts';

const events: Array<Record<string, unknown>> = [];
const emit = (event: Record<string, unknown>) => {
  events.push(event);
};

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${message}`);
}

function eventsOf(type: string): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === type);
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Red or blue?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'warm' },
        { label: 'Blue', description: 'cool' },
      ],
      multiSelect: false,
    },
  ],
};

async function main(): Promise<void> {
  const bridge = new QuestionBridge(emit);
  const notes: string[] = [];

  // 1. Park a question; questionId adopts toolUseID.
  const abort1 = new AbortController();
  const pending1 = bridge.request({
    sessionId: 'sess-1',
    input: { ...QUESTION_INPUT },
    signal: abort1.signal,
    toolUseId: 'toolu_q_1',
  });
  const requested = eventsOf('question.requested');
  assert(requested.length === 1, 'question.requested emitted once');
  const reqPayload = requested[0].payload as {
    questionId: string;
    questions: Array<{ question: string; options: Array<{ label: string }> }>;
  };
  assert(reqPayload.questionId === 'toolu_q_1', 'questionId equals toolUseID');
  assert(reqPayload.questions.length === 1, 'questions parsed');
  assert(reqPayload.questions[0].options.length === 2, 'options parsed');
  assert(
    eventsOf('session.status').some(
      (e) => (e.payload as { status: string }).status === 'waiting_question'
    ),
    'status waiting_question emitted'
  );
  notes.push('park+requested ok');

  // 2. Empty respond payload is refused (bare-allow footgun guard).
  assert(
    bridge.respond({ sessionId: 'sess-1', questionId: 'toolu_q_1' }) === false,
    'empty respond payload refused'
  );
  assert(bridge.hasPending('sess-1'), 'still pending after refused respond');

  // 3. Session mismatch is refused.
  assert(
    bridge.respond({
      sessionId: 'sess-other',
      questionId: 'toolu_q_1',
      answers: { 'Red or blue?': 'Blue' },
    }) === false,
    'session mismatch refused'
  );

  // 4. Answers settle as allow + updatedInput carrying original input + answers.
  assert(
    bridge.respond({
      sessionId: 'sess-1',
      questionId: 'toolu_q_1',
      answers: { 'Red or blue?': 'Blue' },
    }) === true,
    'respond accepted'
  );
  const result1 = await pending1;
  assert(result1.behavior === 'allow', 'answered → allow');
  const updated1 = (result1 as { updatedInput?: Record<string, unknown> }).updatedInput;
  assert(updated1, 'allow carries updatedInput');
  assert(Array.isArray(updated1.questions), 'updatedInput keeps original questions');
  assert(
    (updated1.answers as Record<string, string>)['Red or blue?'] === 'Blue',
    'updatedInput.answers injected'
  );
  const resolved1 = eventsOf('question.resolved');
  assert(resolved1.length === 1, 'question.resolved emitted once');
  const resPayload1 = resolved1[0].payload as {
    outcome: string;
    answers?: Record<string, string>;
  };
  assert(resPayload1.outcome === 'answered', 'outcome answered');
  assert(resPayload1.answers?.['Red or blue?'] === 'Blue', 'resolved carries answers');
  assert(
    eventsOf('session.status').some((e) => (e.payload as { status: string }).status === 'running'),
    'status running restored after settle'
  );
  notes.push('answers settle ok');

  // 5. Exactly-once: second respond refused.
  assert(
    bridge.respond({
      sessionId: 'sess-1',
      questionId: 'toolu_q_1',
      answers: { 'Red or blue?': 'Red' },
    }) === false,
    'second respond refused'
  );

  // 6. Cancel settles allow + explicitly empty answers, outcome cancelled.
  const abort2 = new AbortController();
  const pending2 = bridge.request({
    sessionId: 'sess-1',
    input: { ...QUESTION_INPUT },
    signal: abort2.signal,
    toolUseId: 'toolu_q_2',
  });
  assert(
    bridge.respond({ sessionId: 'sess-1', questionId: 'toolu_q_2', cancel: true }) === true,
    'cancel accepted'
  );
  const result2 = await pending2;
  assert(result2.behavior === 'allow', 'cancel → allow (no denial record)');
  const updated2 = (result2 as { updatedInput?: Record<string, unknown> }).updatedInput;
  assert(
    updated2 &&
      typeof updated2.answers === 'object' &&
      Object.keys(updated2.answers as object).length === 0,
    'cancel → empty answers object present'
  );
  const resolved2 = eventsOf('question.resolved')[1].payload as { outcome: string };
  assert(resolved2.outcome === 'cancelled', 'outcome cancelled');
  notes.push('cancel settle ok');

  // 7. Freeform response settles via updatedInput.response.
  const abort3 = new AbortController();
  const pending3 = bridge.request({
    sessionId: 'sess-1',
    input: { ...QUESTION_INPUT },
    signal: abort3.signal,
    toolUseId: 'toolu_q_3',
  });
  assert(
    bridge.respond({
      sessionId: 'sess-1',
      questionId: 'toolu_q_3',
      response: 'Actually I prefer green.',
    }) === true,
    'freeform respond accepted'
  );
  const result3 = await pending3;
  assert(result3.behavior === 'allow', 'freeform → allow');
  const updated3 = (result3 as { updatedInput?: Record<string, unknown> }).updatedInput;
  assert(updated3?.response === 'Actually I prefer green.', 'updatedInput.response injected');
  const resolved3 = eventsOf('question.resolved')[2].payload as {
    outcome: string;
    response?: string;
  };
  assert(resolved3.outcome === 'answered', 'freeform outcome answered');
  assert(resolved3.response === 'Actually I prefer green.', 'resolved carries response');
  notes.push('freeform settle ok');

  // 8. Abort rejects pending question: deny + interrupt, outcome rejected.
  const abort4 = new AbortController();
  const pending4 = bridge.request({
    sessionId: 'sess-1',
    input: { ...QUESTION_INPUT },
    signal: abort4.signal,
    toolUseId: 'toolu_q_4',
  });
  abort4.abort();
  const result4 = await pending4;
  assert(result4.behavior === 'deny', 'abort → deny');
  assert((result4 as { interrupt?: boolean }).interrupt === true, 'abort → interrupt');
  const resolved4 = eventsOf('question.resolved')[3].payload as { outcome: string };
  assert(resolved4.outcome === 'rejected', 'abort outcome rejected');
  assert(!bridge.hasPending('sess-1'), 'no pending after abort');
  notes.push('abort reject ok');

  // 9. rejectSession clears a parked question fail-closed.
  const abort5 = new AbortController();
  const pending5 = bridge.request({
    sessionId: 'sess-2',
    input: { ...QUESTION_INPUT },
    signal: abort5.signal,
    toolUseId: 'toolu_q_5',
  });
  bridge.rejectSession('sess-2', 'Session closed');
  const result5 = await pending5;
  assert(result5.behavior === 'deny', 'rejectSession → deny');
  assert(!bridge.hasPending(), 'no pending after rejectSession');
  notes.push('rejectSession ok');

  console.log(
    JSON.stringify({
      ok: true,
      eventCount: events.length,
      eventTypes: [...new Set(events.map((e) => e.type))],
      notes,
    })
  );
}

main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(2);
});
