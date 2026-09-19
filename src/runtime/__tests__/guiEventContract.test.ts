import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import { reviewFromToolResult } from '../../shared/sessionFileChange.ts';
import type { RuntimeEvent } from '../../shared/types/runtimeEvents.ts';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

/**
 * P4-5, runtime half — the event stream a GUI session actually receives.
 *
 * The renderer is not reached from here: `src/renderer` is outside this
 * package's type-check gate (it has no `@shared` path mapping and no DOM lib),
 * and importing a zustand store into the runtime program would break
 * `typecheck:runtime` for everyone. So the two halves meet on a FIXTURE instead:
 * this file records what the native backend emits, and
 * `src/renderer/stores/__tests__/nativeStreamReplay.test.ts` replays that exact
 * recording through the real reducers to assert what the user ends up seeing.
 *
 * The fixture is normalized (see `normalize`) so it says what the GUI depends on
 * and nothing else — a re-recorded token count or a temp directory must not fail
 * a timeline test. Everything the renderer reads survives verbatim.
 *
 * Regenerate with `AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run guiEventContract`,
 * and read the diff before committing it: a field that vanishes here is a field
 * the GUI stops receiving.
 */

const FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiEventStream.json'
);
/** The P5-2 delegation surface, recorded on its own. See `runGuiSubagentSession`. */
const SUBAGENT_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiSubagentEventStream.json'
);
/**
 * T017 — three more surfaces the renderer draws and this pair never recorded.
 *
 * One session each rather than more turns in the main recording: that one is
 * P4-5's sign-off and folding new rounds into it would renumber its ids, hiding
 * a real change in the noise. Each is small, and each covers a surface whose
 * failure mode is silence — a thinking block that never opens, a question card
 * that never appears, a summary row that leaves no trace, a retry the user
 * cannot tell from a slow model.
 */
const QUESTION_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiQuestionEventStream.json'
);
const COMPACTION_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiCompactionEventStream.json'
);
const RETRY_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiRetryEventStream.json'
);
const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
const MODEL = 'faux/faux-e2e';
const SESSION = 'logical-gui';

let workspace: string;
let agentDir: string;
let server: PiWorkerRpcServer | undefined;
let faux: ReturnType<typeof fauxProvider>;
let outbound: unknown[];

function responses(): WorkerRpcResponse[] {
  return outbound.filter(
    (message): message is WorkerRpcResponse => (message as { kind?: string }).kind === 'response'
  );
}
function events(): RuntimeEvent[] {
  return outbound
    .filter((message) => (message as { type?: string }).type === 'runtime.event')
    .map((message) => (message as { payload: RuntimeEvent }).payload);
}

/** Every context the provider was handed, so a dropped attachment is provable. */
let providerContexts: unknown[];

let requestSequence = 0;
async function call<T>(type: string, payload: unknown): Promise<T> {
  const requestId = `rpc-${++requestSequence}`;
  server?.receive({
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation: 1,
    requestId,
    type,
    payload,
  });
  const response = await waitFor(
    () => responses().find((item) => item.requestId === requestId),
    `response to ${type}`
  );
  if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
  return response.result as T;
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Matched ANYWHERE in a string, not anchored.
 *
 * A delegation id does not only arrive as a field of its own: `Task` answers
 * the model with "Delegation <uuid> started…", and the renderer's lane store
 * keys off ids that embed one. Anchoring the match left those spellings raw, so
 * the recording changed every run for reasons that mean nothing.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Wall-clock milliseconds embedded in an id, e.g. `<agentId>:1757…`. */
const EPOCH_MS = /\b\d{13}\b/g;

/**
 * The same instant as a NUMBER rather than inside a string.
 *
 * T093 put two absolute timestamps on `session.status.retry` (`retryAt`,
 * `attemptStartedAt`) so the banner can run a live countdown. They move every
 * run by definition, and `walk` only rewrote epoch milliseconds it found in
 * TEXT — so without this the retry recording would have had to be re-cut on
 * every execution, which is the opposite of what a golden stream is for. The
 * window is the 13-digit range, the same one `EPOCH_MS` matches, so a genuine
 * measurement (a token count, a delay in ms) is never caught by it.
 */
function isEpochMs(value: number): boolean {
  return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000;
}

/**
 * Replace the temp workspace with `<workspace>`, in both the plain and the
 * JSON-escaped spelling, and normalize the separators that follow it.
 *
 * One recording serves both platforms: Windows emits `<workspace>\notes.txt`
 * where Linux emits `<workspace>/notes.txt`, and a tool result that embeds JSON
 * carries the same path with its backslashes doubled. Only the substituted path
 * run is touched, because a string can hold a backslash of its own — the read
 * result is literally `the answer is 42\n` — and that one is content, not a
 * separator.
 */
function withoutWorkspacePath(value: string, workspacePath: string): string {
  return value
    .split(workspacePath.replace(/\\/g, '\\\\'))
    .join('<workspace>')
    .split(workspacePath)
    .join('<workspace>')
    .replace(/<workspace>[^\s"]*/g, (path) => path.replace(/\\+/g, '/'));
}

/**
 * Strip what changes run to run, keep what the renderer reads.
 *
 * Ids are renumbered rather than blanked because the GUI's whole timeline is
 * built by MATCHING them — a `tool.started` whose `messageId` names no open
 * message is silently dropped, so a fixture that lost the correspondence would
 * hide exactly the defect this pair of tests exists to catch.
 */
function normalize(stream: readonly RuntimeEvent[], workspacePath: string): unknown[] {
  const ids = new Map<string, string>();
  const walk = (value: unknown, zeroNumbers: boolean): unknown => {
    if (typeof value === 'number') {
      if (zeroNumbers) return 0;
      return isEpochMs(value) ? '<ms>' : value;
    }
    if (typeof value === 'string') {
      const withoutWorkspace = withoutWorkspacePath(value, workspacePath);
      return withoutWorkspace
        .replace(UUID, (uuid) => {
          const existing = ids.get(uuid);
          if (existing) return existing;
          const minted = `id-${ids.size + 1}`;
          ids.set(uuid, minted);
          return minted;
        })
        .replace(EPOCH_MS, '<ms>');
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, zeroNumbers));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item, zeroNumbers)])
      );
    }
    return value;
  };
  return stream.map((event) => {
    // `seq` and `timestamp` are stamped by the RPC server on the way out and
    // carry no GUI meaning beyond their order, which the array already holds.
    const { seq: _seq, timestamp: _timestamp, ...rest } = event;
    // Token counts move whenever the system prompt or the tool list does, and a
    // prompt edit in a later phase must not fail a timeline test. The SHAPE is
    // what the renderer's metadata row reads, so that is what is kept.
    //
    // `subagent.activity` is here for the same reason twice over: its terminal
    // payload carries a wall-clock `endedAt` and a measured `durationMs`, and
    // neither is a thing the panel's correctness depends on.
    return walk(rest, event.type === 'usage.updated' || event.type === 'subagent.activity');
  });
}

function startServer(): void {
  outbound = [];
  server = new PiWorkerRpcServer({
    port: { postMessage: (message: unknown) => outbound.push(message) },
    generation: 1,
    projectTrusted: true,
    // P6-5 made these required: the server has no second backend to fall back
    // to. This test drives sessions only, so reaching either is a bug.
    createImportWriter: () => {
      throw new Error('this test supplies no import writer');
    },
    createUtilityRuntime: () => {
      throw new Error('this test supplies no utility runtime');
    },
    createRuntime: (options) =>
      new NativeWorkerRuntime({
        ...options,
        host: HOST,
        agentDir,
        create: (bootstrapOptions) =>
          createRuntime({ ...bootstrapOptions, providers: [faux.provider] }),
      }),
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'runtime-gui-work-'));
  agentDir = await mkdtemp(join(tmpdir(), 'runtime-gui-agent-'));
  await writeFile(join(workspace, 'notes.txt'), 'the answer is 42\n');
  faux = fauxProvider({
    provider: 'faux',
    // The golden stream compares event boundaries too. Faux defaults to random
    // token sizes, so even a final punctuation mark can become an extra delta.
    tokenSize: { min: 128, max: 128 },
    models: [{ id: 'faux-e2e', name: 'Faux GUI', contextWindow: 128_000, maxTokens: 4_096 }],
  });
  requestSequence = 0;
  providerContexts = [];
  startServer();
});

afterEach(async () => {
  await call('worker.dispose', { reason: 'test' }).catch(() => undefined);
  server = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

/**
 * One session that touches every surface P4-5 signs off: a prompt with an
 * attachment (composer), a tool the policy allows without asking and one the
 * user is asked about (timeline + permission card), and a closing answer.
 */
async function runGuiSession(): Promise<RuntimeEvent[]> {
  faux.setResponses([
    (context) => {
      providerContexts.push(context);
      return fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' })], {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage(
      [fauxToolCall('write', { path: 'created.txt', content: 'hi\n' }, { id: 'call-2' })],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('The note says the answer is 42, and I wrote the file.'),
  ]);
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'read then write',
    model: MODEL,
    attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'spec.md', data: '# spec\n' }],
  });

  const request = await waitFor(
    () =>
      events().find((event) => event.type === 'permission.requested') as
        | Extract<RuntimeEvent, { type: 'permission.requested' }>
        | undefined,
    'the permission request'
  );
  await call('worker.permission.respond', {
    logicalSessionId: SESSION,
    permissionId: request.payload.permissionId,
    decision: 'allow',
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle'
  );
  return events();
}

/**
 * A second session, for the delegation surface only.
 *
 * Recorded separately rather than folded into `runGuiSession`: that recording
 * is the sign-off for P4-5's surfaces and re-cutting all of it to add subagent
 * rows would renumber every id in it, hiding any real change in the noise. This
 * one adds what P5-2 put on the wire — `subagent.activity` — and pins the two
 * things the delegation path is supposed NOT to put there: a user bubble for
 * the report the runtime feeds back, and a permission row with no owner.
 *
 * Ordering is made deterministic by the parent's second turn waiting for the
 * delegate's terminal activity. That is not an artificial serialization of a
 * race: the parent is idle at that point either way, and the runtime — not the
 * model — is what waits for delegates. Recording the interleaving instead would
 * pin timing, which is the one thing here that carries no meaning.
 */
async function runGuiSubagentSession(): Promise<RuntimeEvent[]> {
  let parentTurn = 0;
  let delegateTurn = 0;
  const route = async (context: { systemPrompt?: string }) => {
    if (/You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '')) {
      delegateTurn += 1;
      return delegateTurn === 1
        ? fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id: 'sub-read' })], {
            stopReason: 'toolUse',
          })
        : fauxAssistantMessage('EXPLORER-REPORT: notes.txt says the answer is 42.');
    }
    parentTurn += 1;
    if (parentTurn === 1) {
      return fauxAssistantMessage(
        [
          fauxToolCall(
            'Task',
            {
              agent: 'explorer',
              task: 'read notes.txt and report the answer',
              description: 'survey notes',
            },
            { id: 'call-task' }
          ),
        ],
        { stopReason: 'toolUse' }
      );
    }
    if (parentTurn === 2) {
      await waitFor(
        () =>
          events().find(
            (event) => event.type === 'subagent.activity' && event.payload.kind === 'report'
          ),
        'the delegate to settle'
      );
      return fauxAssistantMessage('The explorer is on it.');
    }
    return fauxAssistantMessage('The explorer says the answer is 42.');
  };
  faux.setResponses(Array.from({ length: 16 }, () => route));
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'find out what the notes say',
    model: MODEL,
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle',
    30_000
  );
  return events();
}

describe('the delegation stream the GUI receives (P5-2)', () => {
  it('still matches the recording of a session that delegated', async () => {
    const recorded = normalize(await runGuiSubagentSession(), workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(SUBAGENT_FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    expect(recorded).toEqual(JSON.parse(await readFile(SUBAGENT_FIXTURE, 'utf8')));
  }, 60_000);

  it('gives the delegate its own lane, from start to report', async () => {
    const lane = (await runGuiSubagentSession()).filter(
      (event) => event.type === 'subagent.activity'
    );
    expect(lane.map((event) => event.payload.kind)).toEqual([
      'started',
      'tool.started',
      'tool.completed',
      'text',
      'status',
      'report',
    ]);
    // One delegation, and every row says which parent call owns it.
    const owners = new Set(lane.map((event) => event.payload.parentToolCallId));
    expect([...owners]).toEqual(['call-task']);
    expect(new Set(lane.map((event) => event.payload.agentId)).size).toBe(1);
  }, 60_000);

  it('draws no user bubble for the report the runtime feeds back', async () => {
    // The auto-resume hands the delegate's report to the parent as a prompt, and
    // pi shapes any prompt as a user message. Unmarked, the user sees a message
    // they never wrote — carrying their own send's attemptId — and the reopened
    // session keeps it as their newest request.
    const stream = await runGuiSubagentSession();
    const users = stream.filter(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    expect(users).toHaveLength(1);
    expect(users[0].type === 'message.started' && users[0].payload.attemptId).toBe('attempt-1');
    expect(
      JSON.stringify(stream.filter((event) => event.type.startsWith('message.')))
    ).not.toContain('EXPLORER-REPORT');
  }, 60_000);

  it('records the delegate own gate, named for the delegate', async () => {
    // `read` under the ask gear is a policy allow: no card, no dialog. This row
    // is the only evidence the call was gated at all, and before P5-2 hardening
    // every one a subagent raised was filtered out of the run it belonged to.
    const stream = await runGuiSubagentSession();
    const activity = stream.filter((event) => event.type === 'permission.activity');
    expect(activity.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        phase: 'decision',
        requestId: 'sub-read',
        surface: 'read',
        result: 'allow',
        resolution: 'policy_allow',
        agentName: 'explorer',
      })
    );
    // Attribution, not authorization: the row names the delegation so the
    // transcript can say who was checked (decision 003 keeps the grant itself
    // session scoped).
    const delegate = activity.find(
      (event) => event.type === 'permission.activity' && event.payload.requestId === 'sub-read'
    );
    expect(delegate?.type === 'permission.activity' && delegate.payload.delegationId).toBeTruthy();
  }, 60_000);
});

/**
 * Thinking, then a question the user answers.
 *
 * The thinking block is the first half on purpose: it is the only surface where
 * the projector opens a block of its own, and a reasoning model puts one in
 * front of nearly every answer. The `ask` half then covers the other card the
 * renderer can raise — same park-and-resume shape as a permission gate, with
 * the difference that skipping it is a normal answer rather than a refusal.
 */
async function runGuiQuestionSession(): Promise<RuntimeEvent[]> {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking('They have not said which store to use, so guessing would be wrong.'),
        fauxText('One thing first.'),
        fauxToolCall(
          'ask',
          {
            questions: [
              {
                question: 'Which database?',
                header: 'Storage',
                options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }],
              },
            ],
          },
          { id: 'call-ask' }
        ),
      ],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('Postgres it is.'),
  ]);
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'set up the database',
    model: MODEL,
  });
  const question = await waitFor(
    () =>
      events().find((event) => event.type === 'question.requested') as
        | Extract<RuntimeEvent, { type: 'question.requested' }>
        | undefined,
    'the question'
  );
  // Answered by the tool's OWN item id, not by position: the ids are what keeps
  // two identically worded questions apart, and an answer under the wrong key
  // reaches the model as a question nobody answered.
  const key = question.payload.questions[0]?.id;
  if (!key) throw new Error('the question arrived without per-item ids');
  await call('worker.question.respond', {
    logicalSessionId: SESSION,
    questionId: question.payload.questionId,
    answers: { [key]: 'Postgres' },
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle'
  );
  return events();
}

/**
 * A model that asks for a fresh window mid-turn.
 *
 * The compaction row is a system message the runtime writes about itself, and
 * it is the only thing on screen that explains why the model's memory of the
 * conversation just changed. The third response is the summary request the
 * compaction makes on its own behalf.
 */
async function runGuiCompactionSession(): Promise<RuntimeEvent[]> {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('new_context', {}, { id: 'call-compact' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('CHECKPOINT: the user asked to start a fresh window.'),
    fauxAssistantMessage('Starting fresh — the note says the answer is 42.'),
  ]);
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'summarize what we have and carry on',
    model: MODEL,
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle'
  );
  return events();
}

/**
 * A gateway fault on the first request, then the same turn recovering.
 *
 * Thrown rather than answered: faux reports a thrown factory as an error event
 * with no preceding `start`, which is the setup failure `providerRetry` owns.
 * The wait is REAL (3s, the first rung of the ladder) because the schedule is
 * not injectable from here — and the recording is what proves the banner both
 * appears and comes down without the turn having to end first.
 */
async function runGuiRetrySession(): Promise<RuntimeEvent[]> {
  faux.setResponses([
    () => {
      throw new Error('503: service unavailable');
    },
    fauxAssistantMessage('Recovered after the gateway hiccup.'),
  ]);
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'say something',
    model: MODEL,
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle',
    30_000
  );
  return events();
}

/**
 * T017 — the three recordings above, each asserted once on the runtime side.
 *
 * The behaviour checks sit in the same `it` as the recording rather than in
 * `it`s of their own: every one of them would need its own full session, and
 * this file already pays for seven. The renderer half of each surface is
 * asserted separately in `nativeStreamReplay.test.ts`.
 */
describe('the surfaces T017 added to the recording', () => {
  it('records a turn that thinks out loud and then asks', async () => {
    const stream = await runGuiQuestionSession();
    // The thinking block opens, streams and closes on the same message as the
    // answer — a block that never closes leaves the timeline mid-thought.
    const thinking = stream.filter((event) => event.type.startsWith('thinking.'));
    expect(thinking.map((event) => event.type)).toEqual([
      'thinking.started',
      'thinking.delta',
      'thinking.completed',
    ]);
    expect(new Set(thinking.map((event) => (event.payload as { blockId: string }).blockId)).size) //
      .toBe(1);
    // The card is asked and answered on one id, which is how the dock retires.
    expect(
      stream
        .filter((event) => event.type.startsWith('question.'))
        .map((event) => [event.type, (event.payload as { questionId: string }).questionId])
    ).toEqual([
      ['question.requested', 'call-ask'],
      ['question.resolved', 'call-ask'],
    ]);
    const recorded = normalize(stream, workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(
        QUESTION_FIXTURE,
        `${JSON.stringify(recorded, null, 2)}
`
      );
    }
    expect(recorded).toEqual(JSON.parse(await readFile(QUESTION_FIXTURE, 'utf8')));
  }, 30_000);

  it('records the summary row a fresh context window leaves behind', async () => {
    const stream = await runGuiCompactionSession();
    // A system message, opened and closed around one delta. The renderer draws
    // it as a compaction row; without it the model's memory changes silently.
    const system = stream.filter(
      (event) => event.type === 'message.started' && event.payload.role === 'system'
    );
    expect(system).toHaveLength(1);
    const messageId = (system[0].payload as { messageId: string }).messageId;
    expect(
      stream.find(
        (event) =>
          event.type === 'message.delta' &&
          (event.payload as { messageId: string }).messageId === messageId
      )?.payload
    ).toMatchObject({ text: expect.stringContaining('Context summary') });
    const recorded = normalize(stream, workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(
        COMPACTION_FIXTURE,
        `${JSON.stringify(recorded, null, 2)}
`
      );
    }
    expect(recorded).toEqual(JSON.parse(await readFile(COMPACTION_FIXTURE, 'utf8')));
  }, 30_000);

  it('records the retry banner going up and coming back down', async () => {
    const stream = await runGuiRetrySession();
    const statuses = stream.filter((event) => event.type === 'session.status');
    // rpc-projector-02: `running` throughout — the turn IS alive — with the
    // retry riding along on exactly one of them and gone by the next.
    expect(statuses.map((event) => event.payload.status)).toEqual([
      'running',
      'running',
      'running',
      'idle',
    ]);
    expect(statuses[1].payload.retry).toMatchObject({
      attempt: 1,
      maxRetries: 3,
      delayMs: 3_000,
      // No status: faux never reaches the fetch wrapper, the same shape a
      // socket that never connected produces.
      errorStatus: null,
      error: 'PROVIDER_ERROR',
    });
    expect(statuses[2].payload.retry).toBeUndefined();
    const recorded = normalize(stream, workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(
        RETRY_FIXTURE,
        `${JSON.stringify(recorded, null, 2)}
`
      );
    }
    expect(recorded).toEqual(JSON.parse(await readFile(RETRY_FIXTURE, 'utf8')));
  }, 30_000);
});

describe('the stream the GUI receives from the native backend (P4-5)', () => {
  it('sends the successful write diff through the actual worker event stream', async () => {
    const stream = await runGuiSession();
    const completed = stream.find(
      (event) => event.type === 'tool.completed' && event.payload.toolCallId === 'call-2'
    );
    expect(
      completed?.type === 'tool.completed' && reviewFromToolResult(completed.payload.output)
    ).toMatchObject({
      status: 'added',
      path: join(workspace, 'created.txt'),
      patch: '@@ -0,0 +1,1 @@\n+hi',
    });
  });
  it('still matches the recording the renderer replays', async () => {
    const recorded = normalize(await runGuiSession(), workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    expect(recorded).toEqual(JSON.parse(await readFile(FIXTURE, 'utf8')));
  }, 30_000);

  it('echoes the send attempt on the user message', async () => {
    // The composer shows the prompt optimistically and retires that bubble when
    // the authoritative echo carrying its own attemptId arrives. Without it the
    // user's message stays on screen twice for the life of the session.
    const echo = (await runGuiSession()).find(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    expect(echo?.payload).toMatchObject({
      attemptId: 'attempt-1',
      attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'spec.md' }],
    });
  }, 30_000);

  it('sends the attachment to the model rather than dropping it', async () => {
    await runGuiSession();
    // Asserted on what the PROVIDER was handed, not on the session file: a
    // transcript that records the document while the request omits it is
    // exactly the silent failure here — the user watches the attachment go up
    // and the model answers as though it never arrived.
    expect(JSON.stringify(providerContexts[0])).toContain('# spec');
  }, 30_000);

  it('records both gates, including the one nobody was asked about', async () => {
    const activity = (await runGuiSession()).filter(
      (event) => event.type === 'permission.activity'
    );
    // The policy allow is the load-bearing one: it raises no dialog, so this row
    // is the only evidence the call was gated rather than simply unchecked.
    expect(activity.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        phase: 'decision',
        requestId: 'call-1',
        surface: 'read',
        result: 'allow',
        resolution: 'policy_allow',
      }),
      expect.objectContaining({ phase: 'prompt', requestId: 'call-2', surface: 'write' }),
      expect.objectContaining({
        phase: 'decision',
        requestId: 'call-2',
        surface: 'write',
        result: 'allow',
        resolution: 'user_approved',
      }),
    ]);
  }, 30_000);

  it('keeps its own bookkeeping entries off the wire', async () => {
    // `aiclient.permissions` records which gate the branch ran under. The
    // renderer turns every custom entry into a visible system message and opens
    // a turn around it, so leaking one puts a row of raw JSON at the top of the
    // conversation.
    const custom = (await runGuiSession()).filter(
      (event) => event.type === 'custom.entry' || event.type === 'custom.message'
    );
    expect(custom).toEqual([]);
  }, 30_000);

  it('opens every message a tool row is attached to', async () => {
    // `applyRuntimeEvent` looks the message up by id and returns `{}` when it
    // finds nothing — a tool call addressed to an unopened message does not
    // error, it just never appears.
    const stream = await runGuiSession();
    const opened = new Set(
      stream.flatMap((event) => (event.type === 'message.started' ? [event.payload.messageId] : []))
    );
    for (const event of stream) {
      if (event.type.startsWith('tool.')) {
        expect(opened).toContain((event.payload as { messageId: string }).messageId);
      }
    }
  }, 30_000);
});
