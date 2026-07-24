/**
 * C-04 gateway smoke: question.requested → question.respond → turn continues.
 * Drives the full Host process over stdio NDJSON (like phase2-permission-smoke).
 *
 * Scenarios (one fresh session each, same Host process):
 *   answers  — respond with a picked option; expect CHOSEN reply, no re-ask.
 *   response — respond with freeform text (updatedInput.response); no re-ask.
 *   cancel   — respond cancel (allow + empty answers); MUST not re-ask.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c04-question-smoke.ts
 *   AICLIENT_C04_SCENARIOS=answers node ... (comma list to subset)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';
import { testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const hostEntry = process.env.AICLIENT_SMOKE_HOST_ENTRY ?? path.join(hostRoot, 'index.ts');

const NODE24 = process.env.AICLIENT_NODE24 ?? process.execPath;
const WORKDIR = process.env.AICLIENT_SMOKE_WORKDIR ?? repoRoot;
const SCENARIO_TIMEOUT_MS = Number(process.env.AICLIENT_C04_TIMEOUT_MS ?? 150000);

const PROMPT =
  'Use the AskUserQuestion tool to ask me whether I prefer red or blue. ' +
  'You must ask before answering. Do not answer without asking. ' +
  'After the tool returns, reply with exactly one line: CHOSEN: <the answer I gave>. ' +
  'If the question was declined or unanswered, reply with exactly: NO-ANSWER';

type ScenarioName = 'answers' | 'response' | 'cancel';

interface ScenarioReport {
  scenario: ScenarioName;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  sawQuestionRequested: boolean;
  questionCount: number;
  optionCount: number;
  sawWaitingQuestion: boolean;
  resolvedOutcome?: string;
  reAsked: boolean;
  terminal?: string;
  assistantPreview: string;
  error?: string;
}

interface HostEvent {
  type?: string;
  sessionId?: string;
  payload?: {
    questionId?: string;
    questions?: Array<{ question?: string; options?: Array<{ label?: string }> }>;
    outcome?: string;
    status?: string;
    text?: string;
    message?: string;
    fatal?: boolean;
    code?: string;
  };
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

function pickAnswers(
  questions: Array<{ question?: string; options?: Array<{ label?: string }> }>
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    if (typeof q?.question !== 'string') continue;
    const labels = (q.options ?? []).map((o) => o?.label).filter((l): l is string => !!l);
    const blue = labels.find((l) => l.toLowerCase().includes('blue'));
    answers[q.question] = blue ?? labels[0] ?? 'blue';
  }
  return answers;
}

function runScenario(
  child: ReturnType<typeof spawn>,
  rl: ReturnType<typeof createInterface>,
  scenario: ScenarioName,
  index: number
): Promise<ScenarioReport> {
  return new Promise((resolve) => {
    const report: ScenarioReport = {
      scenario,
      ok: false,
      timedOut: false,
      durationMs: 0,
      sawQuestionRequested: false,
      questionCount: 0,
      optionCount: 0,
      sawWaitingQuestion: false,
      reAsked: false,
      assistantPreview: '',
    };
    const sessionId = `c04-${scenario}-${Date.now()}-${index}`;
    const started = Date.now();
    let settled = false;
    let respondedOnce = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      rl.off('line', onLine);
      clearTimeout(timer);
      report.durationMs = Date.now() - started;
      if (error) report.error = error;
      report.ok =
        !report.timedOut &&
        report.sawQuestionRequested &&
        !report.reAsked &&
        report.terminal === 'session.completed' &&
        (scenario === 'cancel'
          ? report.resolvedOutcome === 'cancelled'
          : report.resolvedOutcome === 'answered');
      // Close the session so the next scenario starts clean.
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: `close-${sessionId}`,
        type: 'session.close',
        payload: { sessionId },
      });
      resolve(report);
    };

    const timer = setTimeout(() => {
      report.timedOut = true;
      // Stop the hung turn so the Host stays usable for the next scenario.
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: `stop-${sessionId}`,
        type: 'session.stop',
        payload: { sessionId },
      });
      setTimeout(() => finish(`timeout after ${SCENARIO_TIMEOUT_MS}ms`), 2000);
    }, SCENARIO_TIMEOUT_MS);

    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: HostEvent;
      try {
        event = JSON.parse(trimmed) as HostEvent;
      } catch {
        return;
      }
      if (event.sessionId !== sessionId) return;
      const type = String(event.type ?? '');

      if (type === 'session.status' && event.payload?.status === 'waiting_question') {
        report.sawWaitingQuestion = true;
      }
      if (type === 'message.delta' && typeof event.payload?.text === 'string') {
        const text = event.payload.text;
        if (text && text !== PROMPT) {
          report.assistantPreview = (report.assistantPreview + text).slice(0, 300);
        }
      }
      if (type === 'question.requested') {
        const questionId = event.payload?.questionId;
        const questions = event.payload?.questions ?? [];
        if (!report.sawQuestionRequested) {
          report.sawQuestionRequested = true;
          report.questionCount = questions.length;
          report.optionCount = questions[0]?.options?.length ?? 0;
        } else {
          // A second ask within the same turn means the CLI discarded our
          // response (the bare-allow footgun) — the core failure signal here.
          report.reAsked = true;
        }
        if (!questionId) return;
        let payload: Record<string, unknown>;
        if (report.reAsked || (respondedOnce && scenario !== 'answers')) {
          // Drain unexpected re-asks quickly with real answers.
          payload = { sessionId, questionId, answers: pickAnswers(questions) };
        } else if (scenario === 'answers') {
          payload = { sessionId, questionId, answers: pickAnswers(questions) };
        } else if (scenario === 'response') {
          payload = { sessionId, questionId, response: 'Neither — I actually prefer green.' };
        } else {
          payload = { sessionId, questionId, cancel: true };
        }
        respondedOnce = true;
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: `respond-${sessionId}`,
          type: 'question.respond',
          payload,
        });
      }
      if (type === 'question.resolved') {
        if (!report.resolvedOutcome) report.resolvedOutcome = event.payload?.outcome;
      }
      if (type === 'session.completed' || type === 'session.failed' || type === 'session.stopped') {
        report.terminal = type;
        finish(type === 'session.failed' ? 'session.failed' : undefined);
      }
      if (type === 'host.error' && event.payload?.fatal) {
        finish(event.payload.message ?? 'fatal host.error');
      }
    };

    rl.on('line', onLine);

    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `create-${sessionId}`,
      type: 'session.create',
      payload: { sessionId, workspacePath: WORKDIR },
    });
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `send-${sessionId}`,
      type: 'session.send',
      payload: { sessionId, text: PROMPT },
    });
  });
}

async function main(): Promise<void> {
  const requested = (process.env.AICLIENT_C04_SCENARIOS ?? 'answers,response,cancel')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ScenarioName => ['answers', 'response', 'cancel'].includes(s));

  const child = spawn(NODE24, ['--experimental-strip-types', hostEntry], {
    cwd: hostRoot,
    env: {
      ...process.env,
      ...testCredentialEnv(WORKDIR),
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString('utf8'));
  });

  const rl = createInterface({ input: child.stdout! });

  let hostReady = false;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const event = JSON.parse(line) as HostEvent;
        if (event.type === 'host.ready') {
          hostReady = true;
          rl.off('line', onLine);
          resolve();
        }
        if (event.type === 'host.error' && event.payload?.fatal) {
          rl.off('line', onLine);
          reject(new Error(event.payload.message ?? 'fatal host.error'));
        }
      } catch {
        // not JSON — ignore
      }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      if (!hostReady) reject(new Error('host.ready timeout (60s)'));
    }, 60000);
  });

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'init-1',
    type: 'host.initialize',
    payload: { driver: 'agent-sdk' },
  });

  const reports: ScenarioReport[] = [];
  try {
    await readyPromise;
    console.error('[c04] host ready');
    for (const [index, scenario] of requested.entries()) {
      console.error(`[c04] running scenario: ${scenario}`);
      const report = await runScenario(child, rl, scenario, index);
      console.error(
        `[c04] ${scenario}: ok=${report.ok} outcome=${report.resolvedOutcome} ` +
          `reAsked=${report.reAsked} terminal=${report.terminal} durationMs=${report.durationMs}`
      );
      reports.push(report);
    }
  } catch (err) {
    reports.push({
      scenario: requested[0] ?? 'answers',
      ok: false,
      timedOut: false,
      durationMs: 0,
      sawQuestionRequested: false,
      questionCount: 0,
      optionCount: 0,
      sawWaitingQuestion: false,
      reAsked: false,
      assistantPreview: '',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const summary = {
    ok: reports.length === requested.length && reports.every((r) => r.ok),
    hostReady,
    reports,
    stderrTail: stderrChunks.join('').slice(-800),
  };
  console.log(JSON.stringify(summary, null, 2));

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'shutdown-1',
    type: 'host.shutdown',
  });
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
    process.exit(summary.ok ? 0 : 2);
  }, 800);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
