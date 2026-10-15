/**
 * The PiLab+SDK arm (route B): the Claude Agent SDK host from this checkout
 * (src/claude-sdk-host/host.ts), forked on this Node with an IPC channel and
 * driven over worker RPC the way Main's WorkerSlot drives it
 * (src/claude-sdk-host/tools/host-probe.ts), one host per run. Its launch
 * variables are Main's (claudeSdkEngine.ts) over the sandbox's allowlist: a
 * throwaway CLAUDE_CONFIG_DIR, the gateway and key in
 * AICLIENT_CLAUDE_SDK_BASE_URL / _API_KEY (the host keeps the key in memory
 * and hands it to the CLI child only), setting sources `project`. The session
 * runs in the `bypass` gear; a card the model raises itself (a question, a
 * plan review) is answered at once, as on the PiLab arm. The step budget is
 * the CLI's own cap (AICLIENT_CLAUDE_SDK_MAX_TURNS, the SDK's `maxTurns`), as
 * `--max-turns` is on the Claude Code arm; the harness's Stop at call
 * maxSteps+1 stays as a backstop. (The host's Stop samples the process tree
 * before it interrupts the CLI, so on Windows a fast loop runs on for a
 * moment: measured on the fake gateway, three more steps.)
 *
 * The host also writes the SDK's messages to a log in the sandbox
 * (AICLIENT_CLAUDE_SDK_MESSAGE_LOG): the token totals, the offered tools and
 * subagent calls come from there (`summarizeSdkHost`).
 *
 * A variant may set host environment variables and files in the config
 * directory (e.g. `settings.json`).
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLAN_REVIEW_QUESTION_ID } from '../../../../shared/planReview.ts';
import type { Gateway } from './gateway.ts';
import { type CardTally, HEADLESS_ANSWER } from './pilab.ts';
import { forkTracked, killTree } from './proc.ts';
import type { Redactor } from './redact.ts';
import type { Sandbox } from './sandbox.ts';
import { type HostEvent, summarizeSdkHost } from './sdkEvents.ts';
import type { ClientRun, LoadedVariant, RunStatus } from './types.ts';

type Json = Record<string, unknown>;

/** How long a session must stay idle before the run counts as over (as on the PiLab arm). */
const SETTLE_MS = 2_000;
const GENERATION = 1;
const BYPASS = { mode: 'agent', gear: 'bypass' } as const;

export function sdkHostEntry(repoRoot: string): string {
  return join(repoRoot, 'src', 'claude-sdk-host', 'host.ts');
}

/** The SDK package and the CLI it bundles, from the host's node_modules. */
export function sdkVersions(repoRoot: string): { sdk?: string; cli?: string } {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          'src',
          'claude-sdk-host',
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk',
          'package.json'
        ),
        'utf8'
      )
    ) as Json;
    return {
      ...(typeof pkg.version === 'string' ? { sdk: pkg.version } : {}),
      ...(typeof pkg.claudeCodeVersion === 'string' ? { cli: pkg.claudeCodeVersion } : {}),
    };
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Worker RPC over the host's IPC channel: requests, and every runtime event with its arrival time. */
class SdkHostClient {
  readonly events: HostEvent[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<() => void>();
  private zero = performance.now();
  readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (this.stderr.length < 20_000) this.stderr.push(...chunk.split('\n').filter(Boolean));
    });
    child.stdout?.resume();
    child.on('message', (raw) => {
      if (!isRecord(raw)) return;
      if (raw.kind === 'response') {
        const waiter = this.pending.get(String(raw.requestId));
        this.pending.delete(String(raw.requestId));
        if (raw.ok) waiter?.resolve(isRecord(raw.result) ? raw.result : {});
        else waiter?.reject(new Error(`RPC failed: ${JSON.stringify(raw.error)}`));
      } else if (raw.kind === 'event' && raw.type === 'runtime.event' && isRecord(raw.payload)) {
        const event = raw.payload as unknown as HostEvent;
        this.events.push({ ...event, t: Math.round(performance.now() - this.zero) });
        for (const listener of [...this.listeners]) listener();
      }
    });
    this.exited = new Promise((done) => {
      child.once('exit', (code, signal) => {
        for (const waiter of this.pending.values()) waiter.reject(new Error('the host exited'));
        this.pending.clear();
        for (const listener of [...this.listeners]) listener();
        done({ code, signal });
      });
    });
  }

  /** Event times count from now on. */
  markZero(): void {
    this.zero = performance.now();
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  request(type: string, payload: Json, timeoutMs = 60_000): Promise<Json> {
    if (!this.child.connected) return Promise.reject(new Error('the host is not connected'));
    const requestId = `ab-sdk-${++this.seq}`;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.send({
        protocolVersion: 1,
        kind: 'request',
        generation: GENERATION,
        requestId,
        type,
        payload,
      });
    });
  }

  /** Resolves true once `test(events)` holds, false after `ms` or when the host exits. */
  until(test: (events: readonly HostEvent[]) => boolean, ms: number): Promise<boolean> {
    if (test(this.events)) return Promise.resolve(true);
    return new Promise((done) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        done(value);
      };
      const check = () => {
        if (test(this.events)) finish(true);
        else if (!this.alive) finish(false);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, ms));
      this.listeners.add(check);
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    let seen = this.events.length;
    const wrapped = () => {
      while (seen < this.events.length) listener(this.events[seen++] as HostEvent);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }
}

/**
 * Answers every card the host raises: a plan review with "run on auto" (no
 * goal), a question with HEADLESS_ANSWER for each of its questions (the CLI's
 * AskUserQuestion reads `answers`), a permission with allow (none should come
 * up in the bypass gear). Counted in `tally`; returns the unsubscribe.
 */
function answerCards(client: SdkHostClient, logicalSessionId: string, tally: CardTally) {
  const seen = new Set<string>();
  const respond = (type: string, payload: Json) => {
    client.request(type, { logicalSessionId, ...payload }, 30_000).catch(() => undefined);
  };
  return client.onEvent((event) => {
    const p = event.payload ?? {};
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
        const questions = Array.isArray(p.questions) ? p.questions : [];
        const answers: Record<string, string> = {};
        for (const item of questions) {
          if (isRecord(item) && typeof item.question === 'string')
            answers[item.question] = HEADLESS_ANSWER;
        }
        respond('worker.question.respond', {
          questionId: id,
          ...(Object.keys(answers).length > 0 ? { answers } : { response: HEADLESS_ANSWER }),
        });
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
  });
}

export interface PilabSdkInput {
  repoRoot: string;
  appVersion: string;
  gitBash?: string;
  box: Sandbox;
  base: Record<string, string>;
  gateway: Gateway;
  model: string;
  effort: string;
  prompt: string;
  timeMs: number;
  maxSteps: number;
  variant?: LoadedVariant;
  clientDir: string;
  redact: Redactor;
  label: string;
}

export async function runPilabSdk(input: PilabSdkInput): Promise<ClientRun> {
  const { box, variant, redact } = input;
  const wallStart = performance.now();
  for (const [name, text] of Object.entries(variant?.resolvedFiles.config ?? {})) {
    const path = join(box.claudeConfig, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const messageLog = join(box.root, 'sdk-messages.jsonl');
  const env: Record<string, string> = {
    ...input.base,
    AICLIENT_CLAUDE_SDK_GENERATION: String(GENERATION),
    AICLIENT_CLAUDE_SDK_CONFIG_DIR: box.claudeConfig,
    AICLIENT_CLAUDE_SDK_BASE_URL: input.gateway.baseUrl,
    AICLIENT_CLAUDE_SDK_API_KEY: input.gateway.apiKey,
    AICLIENT_CLAUDE_SDK_SETTING_SOURCES: 'project',
    AICLIENT_CLAUDE_SDK_CLIENT_APP: `pilab/${input.appVersion}`,
    AICLIENT_CLAUDE_SDK_MESSAGE_LOG: messageLog,
    // The step budget as the CLI's own cap, the way the Claude Code arm passes --max-turns.
    AICLIENT_CLAUDE_SDK_MAX_TURNS: String(input.maxSteps),
    ...(input.gitBash ? { AICLIENT_GIT_BASH_PATH: input.gitBash } : {}),
    ...(variant?.env ?? {}),
  };
  const modelRef = `claude/${input.model}`;
  const logicalSessionId = `ab-sdk-${input.label}`;
  const requestId = `${logicalSessionId}-turn`;
  const info: Record<string, unknown> = {
    modelRef,
    logicalSessionId,
    sdk: sdkVersions(input.repoRoot),
    envOverrides: Object.keys(variant?.env ?? {}),
  };
  const cards: CardTally = { questions: 0, planReviews: 0, permissions: 0, previews: 0 };
  let status: RunStatus = 'completed';
  let error: string | undefined;
  let durationMs = 0;
  let startedAt: number | undefined;
  let from = 0;
  let stopAnswering: (() => void) | undefined;
  const child = forkTracked(sdkHostEntry(input.repoRoot), { cwd: box.ws, env });
  const client = new SdkHostClient(child);
  try {
    const boot = await client.request(
      'worker.bootstrap',
      {
        logicalSessionId,
        cwd: box.ws,
        model: modelRef,
        effort: input.effort,
        permissions: BYPASS,
      },
      120_000
    );
    info.hostReadyMs = Math.round(performance.now() - wallStart);
    info.ccSessionId = boot.piSessionId;
    await client.request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
    stopAnswering = answerCards(client, logicalSessionId, cards);
    from = client.events.length;
    const ours = () => client.events.slice(from);
    const modelCalls = () =>
      ours().filter(
        (event) => event.type === 'message.started' && event.payload?.role === 'assistant'
      ).length;
    const statuses = () => ours().filter((event) => event.type === 'session.status');
    const resting = (event: HostEvent | undefined) =>
      ['idle', 'completed', 'failed'].includes(String(event?.payload?.status));
    const atRest = () => {
      const all = statuses();
      return (
        resting(all.at(-1)) && all.some((event) => resting(event) && event.requestId === requestId)
      );
    };
    startedAt = Date.now();
    client.markZero();
    const sendStart = performance.now();
    const remaining = () => input.timeMs - (performance.now() - sendStart);
    await client.request('worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `${requestId}-attempt`,
      text: input.prompt,
      model: modelRef,
      effort: input.effort,
    });
    // At rest: our turn went idle and so did any turn the CLI started by itself
    // after it (a background task's wake-up); over once no status arrives for SETTLE_MS.
    let lastIdle = sendStart;
    let outcome: 'idle' | 'steps' | 'timeout' | 'exited' = 'idle';
    for (;;) {
      const settled = await client.until(
        () => atRest() || modelCalls() > input.maxSteps,
        remaining()
      );
      if (!client.alive) outcome = 'exited';
      else if (!settled) outcome = 'timeout';
      else outcome = modelCalls() > input.maxSteps ? 'steps' : 'idle';
      if (outcome !== 'idle') break;
      lastIdle = performance.now();
      const seen = statuses().length;
      const woke = await client.until(() => statuses().length > seen, SETTLE_MS);
      if (!woke) break;
    }
    info.extraTurns = new Set(
      statuses()
        .map((event) => event.requestId)
        .filter((id) => typeof id === 'string' && id !== requestId)
    ).size;
    if (outcome === 'steps' || outcome === 'timeout') {
      status = outcome === 'steps' ? 'step_budget' : 'timeout';
      const stopFrom = client.events.length;
      await client
        .request('worker.stop', { logicalSessionId, reason: 'user' }, 30_000)
        .catch(() => undefined);
      await client.until(
        (events) =>
          events
            .slice(stopFrom)
            .some((event) => event.type === 'session.status' && event.payload?.status === 'idle'),
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
    // Dispose closes the CLI (and reaps its tool processes); the host then exits by itself.
    let disposed = false;
    if (client.alive && child.connected) {
      disposed = await client
        .request('worker.dispose', { reason: 'slot-dispose' }, 20_000)
        .then(() => true)
        .catch(() => false);
    }
    const exited = await Promise.race([
      client.exited.then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 15_000)),
    ]);
    if (!exited) killTree(child);
    info.hostStopped = disposed && exited;
    info.hostExit = await Promise.race([
      client.exited,
      new Promise((done) => setTimeout(() => done('still running'), 10_000)),
    ]);
  }
  info.cardsAnswered = cards;
  const wallMs = Math.round(performance.now() - wallStart);
  mkdirSync(input.clientDir, { recursive: true });
  writeFileSync(join(input.clientDir, 'host-stderr.txt'), redact(client.stderr.join('\n')));
  writeFileSync(
    join(input.clientDir, 'host-events.jsonl'),
    client.events.map((event) => redact(JSON.stringify(event))).join('\n')
  );
  const log = existsSync(messageLog) ? readFileSync(messageLog, 'utf8') : '';
  writeFileSync(join(input.clientDir, 'sdk-messages.jsonl'), redact(log));
  const trace = summarizeSdkHost(client.events.slice(from), log, startedAt);
  const init = trace.stream.init ?? {};
  const result = trace.stream.result;
  const ended = client.events
    .slice(from)
    .filter(
      (event) =>
        event.requestId === requestId &&
        ['session.completed', 'session.failed', 'session.stopped'].includes(event.type)
    )
    .at(-1);
  info.turnEnd = ended ? { type: ended.type, ...(ended.payload ?? {}) } : undefined;
  if (status === 'completed' && ended?.payload?.errorCode === 'error_max_turns') {
    status = 'step_budget';
  } else if (status === 'completed' && ended?.type !== 'session.completed') {
    status = 'client_error';
    error = ended
      ? `turn ${ended.type}: ${String(ended.payload?.error ?? ended.payload?.errorCode ?? '')}`
      : 'the turn never ended';
  }
  if (status === 'completed' && log === '') {
    status = 'client_error';
    error = 'no SDK message was logged';
  }
  Object.assign(info, {
    version: init.claude_code_version,
    model: init.model,
    permissionMode: init.permissionMode,
    apiKeySource: init.apiKeySource,
    mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.length : undefined,
    plugins: Array.isArray(init.plugins)
      ? init.plugins.map((plugin: { source?: unknown }) => String(plugin?.source))
      : undefined,
    resultSubtype: result?.subtype,
    isError: result?.is_error,
    numTurns: result?.num_turns,
    durationApiMs: result?.duration_api_ms,
    costUsd: result?.total_cost_usd,
    models: isRecord(result?.modelUsage) ? Object.keys(result.modelUsage) : [],
    badLines: trace.stream.badLines,
    crossCheck: trace.crossCheck,
  });
  return {
    status,
    ...(error ? { error: redact(error) } : {}),
    durationMs,
    wallMs,
    answer: trace.answer,
    events: trace.events,
    offeredTools: trace.offeredTools,
    tokens: trace.tokens,
    tokensSource: trace.tokensSource,
    info,
  };
}
