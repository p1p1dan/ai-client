/**
 * The PiLab arm: a real DSH host from this checkout, driven over worker RPC
 * the way Main's DshHostSupervisor drives one (tools/lib/experiment-host.ts),
 * one host per run. Its environment is Main's own rule
 * (`buildDshHostEnvironment`) over the sandbox's allowlist; its model plan is
 * built by the product's translation from the bundled catalog's Claude
 * provider; the key is handed over IPC per request and never written. The
 * session runs in the `bypass` gear, so no tool call waits on a card.
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
import {
  readyOrFatal,
  startExperimentHost,
  stopExperimentHost,
} from '../../lib/experiment-host.ts';
import { BYPASS_PERMISSIONS, type Message } from '../../lib/hostClient.ts';
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
    const requestId = `${logicalSessionId}-turn`;
    const from = host.client.events(channel).length;
    const isIdle = (events: Message[]) =>
      events
        .slice(from)
        .some(
          (event) =>
            event.type === 'session.status' &&
            payloadOf(event).status === 'idle' &&
            event.requestId === requestId
        );
    const modelCalls = (events: Message[]) =>
      events
        .slice(from)
        .filter(
          (event) => event.type === 'message.started' && payloadOf(event).role === 'assistant'
        ).length;
    startedAt = Date.now();
    const sendStart = performance.now();
    await host.client.request(channel, 'worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `${requestId}-attempt`,
      text: input.prompt,
      model: modelRef,
      effort: input.effort,
    });
    const outcome = await Promise.race([
      host.client
        .until(
          channel,
          (events) => isIdle(events) || modelCalls(events) > input.maxSteps,
          input.timeMs
        )
        .then((settled) => {
          if (!settled) return 'timeout' as const;
          return isIdle(host.client.events(channel)) ? ('idle' as const) : ('steps' as const);
        }),
      host.exited.then(() => 'exited' as const),
    ]);
    if (outcome === 'steps' || outcome === 'timeout') {
      status = outcome === 'steps' ? 'step_budget' : 'timeout';
      await host.client
        .call(channel, 'worker.stop', { logicalSessionId, reason: 'user' }, 30_000)
        .catch(() => undefined);
      await host.client.until(channel, isIdle, 30_000);
    } else if (outcome === 'exited') {
      status = 'client_error';
      error = 'the host exited during the turn';
    }
    durationMs = Math.round(performance.now() - sendStart);
  } catch (caught) {
    status = 'client_error';
    error = String(caught instanceof Error ? caught.message : caught);
  } finally {
    const stopped = await stopExperimentHost(host);
    info.hostStopped = stopped.stopped;
    info.hostExit = stopped.exit;
  }
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
