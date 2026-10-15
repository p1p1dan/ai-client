/**
 * The PiLab arm: a real DSH host from this checkout, driven over worker RPC
 * the way Main's DshHostSupervisor drives one (tools/lib/experiment-host.ts),
 * one host per run. Its environment is Main's own rule
 * (`buildDshHostEnvironment`) over the sandbox's allowlist; its model plan is
 * built by the product's translation from the bundled catalog's Claude
 * provider; the key is handed over IPC per request and never written. The
 * session runs in the `bypass` gear, so no tool call waits on a card, and a
 * card the model raises itself (a question, a plan review) is answered at
 * once (`answerCards`): an unattended run must not wait out its time budget.
 * The run lasts until the session rests, turns it starts by itself included.
 *
 * A variant may set host environment variables, plugin overrides, files in
 * $DSH_HOME (a source-checkout host applies `$DSH_HOME/cordis.patch.yml`) and
 * the agent directory, the plan's request settings, and the model row.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  buildDshHostEnvironment,
  setDshHostEnvEntry,
} from '../../../../main/services/agent-host/dshHostEnvironment.ts';
import { buildDshModelPlan } from '../../../../shared/dshModelPlan/build.ts';
import type { DshRouteSettingsInput } from '../../../../shared/dshModelPlan/types.ts';
import { PLAN_REVIEW_QUESTION_ID } from '../../../../shared/planReview.ts';
import {
  type ExperimentHost,
  readyOrFatal,
  startExperimentHost,
  stopExperimentHost,
} from '../../lib/experiment-host.ts';
import { BYPASS_PERMISSIONS, isRecord, type Message } from '../../lib/hostClient.ts';
import { decodeSessionLog, findSessionLogs, summarizeDshSession } from './dshLog.ts';
import type { Gateway } from './gateway.ts';
import type { Redactor } from './redact.ts';
import type { Sandbox } from './sandbox.ts';
import type { ClientRun, LoadedVariant, RunStatus, TokenUsage, TraceEvent } from './types.ts';

/** The route the plan gives the Claude provider; a model is `claude/<id>`. */
const ROUTE = 'claude';
/** Catalog row cloned for a model the catalog does not list (the gap study's capture did the same). */
const TEMPLATE_MODEL = 'claude-opus-5';

type Row = Record<string, unknown> & { id: string };

/** The catalog's Claude provider and the row for `model` (cloned from a template when absent). */
export function claudeRoute(
  repoRoot: string,
  model: string,
  variant?: LoadedVariant
): { api: string; compat?: Record<string, unknown>; rows: Row[]; template: string } {
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'model-catalog', 'snapshot.json'), 'utf8')
  );
  const provider = catalog.providers?.claude;
  if (!provider) throw new Error('the model catalog has no claude provider');
  const rows = (provider.models as Row[]).map((row) => ({ ...row }));
  let template = model;
  let row = rows.find((item) => item.id === model);
  if (!row) {
    const base = rows.find((item) => item.id === TEMPLATE_MODEL) ?? rows.at(-1);
    if (!base) throw new Error('the catalog lists no Claude model');
    template = base.id;
    row = { ...base, id: model, name: model };
    rows.push(row);
  }
  Object.assign(row, variant?.modelRow ?? {});
  const compat = { ...(provider.compat ?? {}), ...(variant?.compat ?? {}) };
  return {
    api: String(provider.api),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    rows,
    template,
  };
}

function writeFiles(dir: string, files: Record<string, string>): string[] {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return Object.keys(files);
}

function payloadOf(event: Message): Message {
  return (event.payload ?? {}) as Message;
}

/** How long a session must stay idle before the run counts as over. */
const SETTLE_MS = 2_000;

/**
 * What a headless run answers when the model asks the user something. Claude
 * Code under `-p` offers no question tool at all; PiLab's is answered at once
 * with this, the same way every time, instead of waiting out the time budget.
 */
export const HEADLESS_ANSWER =
  'No user is available to answer: this is an unattended run. Proceed with your best judgment and state any assumptions in your final reply.';

export interface CardTally {
  questions: number;
  planReviews: number;
  permissions: number;
  previews: number;
}

/**
 * Answers every card the session raises on `ch`: a question with
 * HEADLESS_ANSWER, a plan review with "run on auto" (no goal), a permission
 * with allow (none should come up in the bypass gear), a preview with "no
 * window". Counted in `tally`; returns the unsubscribe.
 */
function answerCards(
  host: ExperimentHost,
  ch: string,
  logicalSessionId: string,
  tally: CardTally
): () => void {
  const seen = new Set<string>();
  const respond = (type: string, payload: Message) => {
    host.client.call(ch, type, { logicalSessionId, ...payload }, 30_000).catch(() => undefined);
  };
  const onMessage = (message: unknown) => {
    if (!isRecord(message) || message.ch !== ch || !isRecord(message.rpc)) return;
    if (message.rpc.kind !== 'event' || message.rpc.type !== 'runtime.event') return;
    const event = message.rpc.payload as Message;
    const p = payloadOf(event);
    const id = String(p.questionId ?? p.permissionId ?? p.previewId ?? '');
    if (!id || seen.has(`${event.type}:${id}`)) return;
    if (event.type === 'question.requested') {
      seen.add(`${event.type}:${id}`);
      if (p.review !== undefined) {
        tally.planReviews += 1;
        respond('worker.question.respond', {
          questionId: id,
          answers: { [PLAN_REVIEW_QUESTION_ID]: 'run:auto' },
        });
      } else {
        tally.questions += 1;
        respond('worker.question.respond', { questionId: id, response: HEADLESS_ANSWER });
      }
    } else if (event.type === 'permission.requested') {
      seen.add(`${event.type}:${id}`);
      tally.permissions += 1;
      respond('worker.permission.respond', { permissionId: id, decision: 'allow' });
    } else if (event.type === 'preview.requested') {
      seen.add(`${event.type}:${id}`);
      tally.previews += 1;
      respond('worker.preview.respond', {
        previewId: id,
        ok: false,
        error: 'There is no preview window in an unattended run.',
      });
    }
  };
  host.child.on('message', onMessage);
  return () => host.child.off('message', onMessage);
}

export interface PilabInput {
  repoRoot: string;
  appVersion: string;
  box: Sandbox;
  base: Record<string, string>;
  gateway: Gateway;
  model: string;
  effort: string;
  prompt: string;
  timeMs: number;
  maxSteps: number;
  variant?: LoadedVariant;
  /** Where the client's raw artifacts go. */
  clientDir: string;
  redact: Redactor;
  label: string;
}

export async function runPilab(input: PilabInput): Promise<ClientRun> {
  const { box, variant, redact } = input;
  const wallStart = performance.now();
  const written = {
    dshHome: writeFiles(box.dshHome, variant?.resolvedFiles.dshHome ?? {}),
    agentDir: writeFiles(box.agentDir, variant?.resolvedFiles.agentDir ?? {}),
  };
  const env = buildDshHostEnvironment({
    dshHome: box.dshHome,
    nativeCacheDir: box.nativeCache,
    isPackaged: false,
    permissionAgentDir: box.agentDir,
    ...(variant?.plugins ? { pluginOverrides: variant.plugins } : {}),
    env: input.base,
  });
  for (const [name, value] of Object.entries(variant?.env ?? {}))
    setDshHostEnvEntry(env, name, value);
  const route = claudeRoute(input.repoRoot, input.model, variant);
  const plan = buildDshModelPlan({
    models: {
      providers: {
        [ROUTE]: {
          baseUrl: input.gateway.baseUrl,
          api: route.api,
          ...(route.compat ? { compat: route.compat } : {}),
          models: route.rows,
        },
      },
    },
    keyed: { [ROUTE]: true },
    clientVersion: input.appVersion,
    ...(variant?.planSettings ? { settings: variant.planSettings as DshRouteSettingsInput } : {}),
  });
  const modelRef = `${ROUTE}/${input.model}`;
  const host = startExperimentHost({
    label: input.label,
    nodeBin: process.execPath,
    entry: join(input.repoRoot, 'src', 'dsh-host', 'host.ts'),
    cwd: box.ws,
    env,
    plan,
    key: input.gateway.apiKey,
  });
  const info: Record<string, unknown> = {
    modelRef,
    modelTemplate: route.template,
    // The revision hashes routes and therefore the base URL; kept out of records.
    planDropped: plan.dropped,
    variantFiles: written,
    envOverrides: Object.keys(variant?.env ?? {}),
  };
  let status: RunStatus = 'completed';
  let error: string | undefined;
  let durationMs = 0;
  let startedAt: number | undefined;
  let ch: string | undefined;
  let dshSessionId: string | undefined;
  let stopAnswering: (() => void) | undefined;
  const cards: CardTally = { questions: 0, planReviews: 0, permissions: 0, previews: 0 };
  const logicalSessionId = `ab-${input.label}`;
  try {
    const ready = await readyOrFatal(host, 180_000);
    info.hostReadyMs = Math.round(performance.now() - wallStart);
    if (ready?.type !== 'ready') {
      throw new Error(`host did not start: ${String(ready?.message ?? 'no ready in time')}`);
    }
    ch = host.client.openChannel();
    const boot = await host.client.request(
      ch,
      'worker.bootstrap',
      {
        logicalSessionId,
        cwd: box.ws,
        model: modelRef,
        effort: input.effort,
        permissions: BYPASS_PERMISSIONS,
      },
      120_000
    );
    dshSessionId = String(boot.piSessionId);
    const channel = ch;
    stopAnswering = answerCards(host, channel, logicalSessionId, cards);
    const requestId = `${logicalSessionId}-turn`;
    const from = host.client.events(channel).length;
    const modelCalls = (events: Message[]) =>
      events
        .slice(from)
        .filter(
          (event) => event.type === 'message.started' && payloadOf(event).role === 'assistant'
        ).length;
    startedAt = Date.now();
    const sendStart = performance.now();
    const remaining = () => input.timeMs - (performance.now() - sendStart);
    await host.client.request(channel, 'worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `${requestId}-attempt`,
      text: input.prompt,
      model: modelRef,
      effort: input.effort,
    });
    // At rest: our turn went idle and so did whatever ran after it. A turn the
    // session starts by itself (a goal round, a background job's wake-up) is
    // followed to its end; the run is over once no status arrives for SETTLE_MS.
    const statuses = (events: Message[]) =>
      events.slice(from).filter((event) => event.type === 'session.status');
    const resting = (event: Message | undefined) =>
      ['idle', 'completed', 'failed'].includes(String(payloadOf(event ?? {}).status));
    const atRest = (events: Message[]) => {
      const all = statuses(events);
      return (
        resting(all.at(-1)) && all.some((event) => resting(event) && event.requestId === requestId)
      );
    };
    let lastIdle = sendStart;
    let outcome: 'idle' | 'steps' | 'timeout' | 'exited' = 'idle';
    for (;;) {
      outcome = await Promise.race([
        host.client
          .until(
            channel,
            (events) => atRest(events) || modelCalls(events) > input.maxSteps,
            Math.max(0, remaining())
          )
          .then((settled) => {
            if (!settled) return 'timeout' as const;
            return modelCalls(host.client.events(channel)) > input.maxSteps
              ? ('steps' as const)
              : ('idle' as const);
          }),
        host.exited.then(() => 'exited' as const),
      ]);
      if (outcome !== 'idle') break;
      lastIdle = performance.now();
      const seen = statuses(host.client.events(channel)).length;
      const woke = await host.client.until(
        channel,
        (events) => statuses(events).length > seen,
        SETTLE_MS
      );
      if (!woke) break;
    }
    info.extraTurns = new Set(
      statuses(host.client.events(channel))
        .map((event) => event.requestId)
        .filter((id) => typeof id === 'string' && id !== requestId)
    ).size;
    if (outcome === 'steps' || outcome === 'timeout') {
      status = outcome === 'steps' ? 'step_budget' : 'timeout';
      const stopFrom = host.client.events(channel).length;
      await host.client
        .call(channel, 'worker.stop', { logicalSessionId, reason: 'user' }, 30_000)
        .catch(() => undefined);
      await host.client.until(
        channel,
        (events) =>
          events
            .slice(stopFrom)
            .some((event) => event.type === 'session.status' && payloadOf(event).status === 'idle'),
        30_000
      );
      lastIdle = performance.now();
    } else if (outcome === 'exited') {
      status = 'client_error';
      error = 'the host exited during the turn';
      lastIdle = performance.now();
    }
    durationMs = Math.round(lastIdle - sendStart);
  } catch (caught) {
    status = 'client_error';
    error = String(caught instanceof Error ? caught.message : caught);
  } finally {
    stopAnswering?.();
    const stopped = await stopExperimentHost(host);
    info.hostStopped = stopped.stopped;
    info.hostExit = stopped.exit;
  }
  info.cardsAnswered = cards;
  const wallMs = Math.round(performance.now() - wallStart);
  mkdirSync(input.clientDir, { recursive: true });
  writeFileSync(join(input.clientDir, 'host-stderr.txt'), redact(host.stderrLines().join('\n')));
  if (ch) {
    writeFileSync(
      join(input.clientDir, 'bridge-events.jsonl'),
      host.client
        .events(ch)
        .map((event) => redact(JSON.stringify(event)))
        .join('\n')
    );
  }
  // Session logs are flushed for certain once the host has stopped.
  const logs = findSessionLogs(box.dshHome);
  const events: TraceEvent[] = [];
  const tokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let answer = '';
  let offeredTools: string[] = [];
  let other = 0;
  for (const file of logs) {
    const log = decodeSessionLog(file);
    const isMain = dshSessionId !== undefined && basename(dirname(file)) === dshSessionId;
    const name = isMain ? 'session-main.jsonl' : `session-other-${++other}.jsonl`;
    writeFileSync(
      join(input.clientDir, name),
      log.map((event) => redact(JSON.stringify(event))).join('\n')
    );
    const summary = summarizeDshSession(log, { subagent: !isMain, startedAt });
    events.push(...summary.events);
    for (const key of Object.keys(tokens) as Array<keyof TokenUsage>)
      tokens[key] += summary.tokens[key];
    if (isMain) {
      answer = summary.answer;
      offeredTools = summary.offeredTools;
      info.requestConfig = summary.config;
      info.turnEnd = summary.turnEnd;
      info.retries = summary.retries;
      info.failedAttempts = summary.failedAttempts;
      info.systemPromptChars = summary.systemPrompt.length;
      info.systemPromptSha256 = createHash('sha256').update(summary.systemPrompt).digest('hex');
      const end = summary.turnEnd as { kind?: string; error?: { message?: string } } | undefined;
      if (status === 'completed' && end?.kind === 'error') {
        status = 'client_error';
        error = `turn failed: ${end.error?.message ?? 'unknown error'}`;
      }
    }
  }
  info.logicalSessionId = logicalSessionId;
  info.dshSessionId = dshSessionId;
  info.sessions = logs.length;
  if (status === 'completed' && logs.length === 0) {
    status = 'client_error';
    error = 'no session log was written';
  }
  return {
    status,
    ...(error ? { error: redact(error) } : {}),
    durationMs,
    wallMs,
    answer,
    events,
    offeredTools,
    tokens,
    tokensSource: 'session-log',
    info,
  };
}
