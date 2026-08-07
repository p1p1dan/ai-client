/**
 * S2-a spike: capture a REAL `item/tool/requestUserInput` payload from
 * `codex app-server`, answer it, and confirm the turn resumes.
 *
 * Context (open-q #2). The S1 spike drove 9 real turns over both the ACP route
 * and the direct route and NEVER saw a question: we had the JSON Schema but
 * zero samples, so "the adapter is thin (40-80 lines)" was a guess derived from
 * schema-vs-schema comparison, not a measurement. This probe exists to turn
 * that guess into a measurement.
 *
 * WHY S1 MISSED IT (root cause, MEASURED here — two wrong hypotheses first):
 *   H1 "the `default_mode_request_user_input` feature flag gates it"  -> WRONG.
 *   H2 "collaboration mode gates it (plan vs default)"                -> WRONG.
 *   H3 "`[tools.experimental_request_user_input] enabled` gates it"   -> WRONG.
 *   Phase 6 settles it at zero token cost: the outbound Responses request
 *   carries the SAME tool registry
 *     ["exec","wait","request_user_input","collaboration"]
 *   under every combination of the three — bare plan mode, default mode, flag
 *   on, config on. The tool is ALWAYS offered.
 *   => S1's 9 misses, and this probe's own phases 3 and 4, are pure model
 *      CHOICE: the shipped prompt lets the model ask in prose
 *      ("in rare cases ... you may ask it directly without the tool"), and
 *      gpt-5.6-sol takes that exit every time unless the user prompt closes it.
 *   The lever is the PROMPT, not configuration: name the tool literally and
 *   declare the prose channel useless (see FORCED_PROMPT). That produced 4
 *   `item/tool/requestUserInput` requests in one turn on the first try.
 *
 * Collaboration mode still matters for a different reason: `collaborationMode`
 * is a **turn/start** parameter (`{mode:'plan'|'default', settings:{model,...}}`),
 * NOT a thread/start parameter, and Plan mode's developer instructions actively
 * encourage the tool ("Strongly prefer using the `request_user_input` tool")
 * while Default mode discourages it ("strongly prefer making reasonable
 * assumptions ... ask the user directly with a concise plain-text question").
 * So plan mode raises the odds; it does not gate the capability.
 *
 * Other gates found in the binary (all relevant to a production adapter):
 *   - "request_user_input is not supported in exec mode"  -> `codex exec` can
 *     never produce one; app-server only. Confirms the S1 entry-point ruling.
 *   - "request_user_input can only be used by the root thread" -> subagents
 *     cannot ask; no agentId disambiguation is needed on our side.
 *   - "request_user_input requires non-empty options for every question" ->
 *     the server VALIDATES options as non-empty even though the JSON Schema
 *     declares `options` nullable. Free-text-only questions arrive as
 *     `isOther:true` on an option-bearing question, not as `options:null`.
 *   - "Request user input for one to three short questions" -> 1..3 per call
 *     (our QuestionItem contract says 1..4).
 *
 * Phases:
 *   1 CONTRACT  features inventory + schema shapes                (offline, free)
 *   2 FIXTURE   build the ambiguity fixture in the sandbox cwd    (offline, free)
 *   3 PLAN      real turn, collaborationMode=plan, answers the
 *               question and lets the turn finish                 (SPENDS QUOTA)
 *   4 PLANCFG   same, plus `[tools.experimental_request_user_input]` (SPENDS QUOTA)
 *   5 DEFAULT   default collaboration mode arm                    (SPENDS QUOTA)
 *   6 TOOLS     ZERO-QUOTA tool-registry capture via a sinkhole
 *               provider — answers "was the tool even offered?"   (free)
 *   7 FORCED    plan mode + a prompt that closes the prose exit
 *               -> 4 real requestUserInput payloads, answered,
 *                  turn resumed and completed                     (SPENDS QUOTA)
 *   8 EMPTY     same, but answers the first question with
 *               `{answers:{}}` (our `cancel`)                     (SPENDS QUOTA)
 *
 * MEASURED (2026-08-06, 4 real turns total):
 *   phase 3/4  MISS. Model asked in prose (a markdown TOML block with `?`
 *              placeholders), turn/completed, zero server->client requests.
 *   phase 6    tool registry identical in all 5 variants; `request_permissions`
 *              (the U4 tool) is NOT offered even with
 *              `features.request_permissions_tool=true`.
 *   phase 7    HIT. 4x `item/tool/requestUserInput`, ids 0..3 in the SERVER's
 *              own id space. `isOther` true 10/10, `isSecret` false 10/10,
 *              `autoResolutionMs` null 4/4, `options` never null. The question
 *              emits NO item: the `call_...` itemId never appears in any
 *              item/started|completed, so the payload is self-contained (unlike
 *              fileChange approvals, which need itemId correlation for the diff).
 *              `thread/status/changed activeFlags:["waitingOnUserInput"]` brackets
 *              the wait; `serverRequest/resolved {threadId,requestId}` follows the
 *              answer.
 *   phase 8    `{answers:{}}` is a clean CANCEL: status clears, no re-ask, turn
 *              completes. This is the OPPOSITE of the Claude CLI footgun that
 *              questionBridge.ts:8-10 documents (bare allow -> silently re-asked).
 *
 * Isolation: this probe ALWAYS runs against a throwaway CODEX_HOME. The real
 * `~/.codex/config.toml` carries `developer_instructions` that tell the model to
 * never touch code without explicit permission, which produced "sure, I will do
 * that" with zero tool calls in three earlier runs. The throwaway home keeps
 * model_provider / base_url / model / auth.json and drops everything else.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s2-codex-question-probe.ts
 *
 * Env:
 *   S2_OUT_DIR=<path>     raw jsonl + schema land here
 *   S2_CODEX_HOME=<path>  throwaway CODEX_HOME (must already contain
 *                         config.toml + auth.json)
 *   S2_CWD=<path>         sandbox cwd for the thread
 *   S2_PHASES=1,2         comma list; default "1,2" (dry). "1,2,3" is the paid
 *                         primary arm; add 4 only if 3 misses.
 *   S2_MODEL=gpt-5.6-sol
 *   S2_TIMEOUT_MS=180000
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CODEX_BIN = process.env.S2_CODEX_BIN ?? 'codex';
const OUT_DIR = process.env.S2_OUT_DIR ?? path.join(os.tmpdir(), 's2-question');
const CODEX_HOME = process.env.S2_CODEX_HOME ?? path.join(OUT_DIR, 'codex-home');
const SANDBOX_CWD = process.env.S2_CWD ?? path.join(OUT_DIR, 'sandbox');
const MODEL = process.env.S2_MODEL ?? 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.S2_TIMEOUT_MS ?? 180_000);
const PHASES = new Set((process.env.S2_PHASES ?? '1,2').split(',').map((s) => s.trim()));

/**
 * The ambiguity fixture prompt. Design constraints, all taken from the shipped
 * Plan-mode prompt:
 *   - Plan mode demands "at least one targeted non-mutating exploration pass"
 *     before asking, so the fixture must be tiny (one config file) to keep that
 *     pass cheap.
 *   - The needed values must be NOT DISCOVERABLE from the repo, otherwise the
 *     prompt orders the model to explore instead of ask.
 *   - The prompt must forbid mutation so the turn cannot drift into apply_patch
 *     approvals and burn quota.
 */
const QUESTION_PROMPT =
  process.env.S2_PROMPT ??
  'Produce a plan to switch this project from development configuration to production configuration. ' +
    'Read config/settings.toml first, then plan. ' +
    'The production values are NOT stored anywhere in this repository and cannot be discovered by exploring — ' +
    'only I know them. Do not guess them and do not write any files. ' +
    'Ask me for the production values you need before you write the plan.';

/**
 * FORCING prompt. Phase 6 proved the tool is registered unconditionally, so a
 * miss is a model *choice*, not a capability gap. Two levers are added here that
 * the earlier prompts lacked:
 *   (a) the tool is named literally, and prose asking is declared useless
 *       ("I cannot see plain-text questions"), which removes the escape hatch
 *       the shipped prompt grants ("in rare cases ... you may ask it directly");
 *   (b) the question ids/headers are pre-specified, so the payload we capture is
 *       predictable and the answer mapping is verifiable.
 */
const FORCED_PROMPT =
  process.env.S2_PROMPT_FORCED ??
  'I need to switch config/settings.toml from dev to production values. ' +
    'The production values exist only in my head — nothing in this repo or environment reveals them, so exploring cannot answer this. ' +
    'IMPORTANT: my client renders ONLY structured tool questions. I cannot see plain-text questions in your message, so asking in prose will get you no answer at all. ' +
    'Right now, before doing anything else, call the `request_user_input` tool with exactly 3 questions ' +
    '(ids: `prod_host`, `db_url`, `telemetry`), each with 2-3 options and a short header. ' +
    'Do not run any commands, do not write any files, and do not produce a plan until I have answered.';

/** Default-mode arm: the flag is on, but the prompt tells it to assume. */
const DEFAULT_ARM_PROMPT =
  process.env.S2_PROMPT_DEFAULT ??
  'I want to switch config/settings.toml to production values. ' +
    'The production values exist only in my head; nothing in this repo reveals them. ' +
    'Ask me for them as multiple-choice questions before doing anything. Do not write any files.';

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

type Envelope = { dir: '->' | '<-' | '!!'; tMs: number; raw: unknown };

async function log(file: string, env: Envelope): Promise<void> {
  await appendFile(path.join(OUT_DIR, file), `${JSON.stringify(env)}\n`);
}

// ---------------------------------------------------------------------------
// app-server client: newline-delimited JSON-RPC 2.0 over stdio.
// Same wire handling as s1-codex-direct-probe.ts; the only additions are the
// throwaway CODEX_HOME env and an async server-request handler (answering a
// question needs to run after we have inspected the payload).
// ---------------------------------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type ServerRequest = { id: unknown; method: string; params: unknown; tMs: number };

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly notes: Array<{ method: string; params: unknown; tMs: number }> = [];
  readonly serverRequests: ServerRequest[] = [];
  readonly stderr: string[] = [];
  /** Returns the JSON-RPC `result` for a server->client request. */
  serverRequestHandler: ((req: ServerRequest) => Promise<unknown>) | null = null;

  private logFile: string;

  constructor(logFile: string, args: string[] = []) {
    this.logFile = logFile;
    this.child = spawn(CODEX_BIN, ['app-server', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME },
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk);
      void log(this.logFile, { dir: '!!', tMs: ms(), raw: { stderr: chunk } });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const idx = this.buf.indexOf('\n');
      if (idx < 0) break;
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        void log(this.logFile, { dir: '!!', tMs: ms(), raw: { unparsable: line } });
        continue;
      }
      void log(this.logFile, { dir: '<-', tMs: ms(), raw: msg });
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : null;

    if (hasId && method) {
      const req: ServerRequest = { id: msg.id, method, params: msg.params, tMs: ms() };
      this.serverRequests.push(req);
      let result: unknown = {};
      try {
        result = (await this.serverRequestHandler?.(req)) ?? {};
      } catch (e) {
        void log(this.logFile, { dir: '!!', tMs: ms(), raw: { handlerError: String(e) } });
      }
      this.send({ id: msg.id, result });
      return;
    }
    if (hasId) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (method) this.notes.push({ method, params: msg.params, tMs: ms() });
  }

  private send(payload: Record<string, unknown>): void {
    const frame = { jsonrpc: '2.0', ...payload };
    void log(this.logFile, { dir: '->', tMs: ms(), raw: frame });
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  waitFor(pred: (m: string, p: unknown) => boolean, timeoutMs = TIMEOUT_MS): Promise<void> {
    const seen = 0;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        for (let i = seen; i < this.notes.length; i++) {
          if (pred(this.notes[i]!.method, this.notes[i]!.params)) {
            clearInterval(tick);
            resolve();
            return;
          }
        }
        if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error(`timeout ${timeoutMs}ms waiting for notification`));
        }
      }, 50);
    });
  }

  async handshake(): Promise<unknown> {
    const res = await this.request('initialize', {
      clientInfo: { name: 's2-codex-question-probe', title: 'S2-a spike', version: '0.0.1' },
      // experimentalApi is MANDATORY: item/tool/requestUserInput is EXPERIMENTAL
      // and is not dispatched to clients that did not opt in.
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    this.notify('initialized', {});
    return res;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Phase 1 - contract inventory (offline)
// ---------------------------------------------------------------------------

async function phaseContract(): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(CODEX_BIN, ['features', 'list'], {
    env: { ...process.env, CODEX_HOME },
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s{2,}/))
    .filter((c) => c.length >= 3)
    .map(([name, stage, state]) => ({ name: name!, stage: stage!, state: state! }));

  const RE = /(user_input|elicit|approval|permission|ask|question|guardian|request_rule|steer)/i;
  return {
    totalFeatures: rows.length,
    askRelated: rows.filter((r) => RE.test(r.name)),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 - fixture (offline)
// ---------------------------------------------------------------------------

/**
 * A repo whose production values are genuinely absent. Plan mode is instructed
 * to explore before asking, so anything derivable from the tree would be
 * derived instead of asked.
 */
async function phaseFixture(): Promise<Record<string, unknown>> {
  await mkdir(path.join(SANDBOX_CWD, 'config'), { recursive: true });
  await writeFile(
    path.join(SANDBOX_CWD, 'config', 'settings.toml'),
    [
      '# The ONLY config file in this project.',
      '[server]',
      'host = "localhost"',
      'port = 3000',
      '',
      '[database]',
      'url = "postgres://localhost:5432/appdev"',
      'pool_size = 5',
      '',
      '[telemetry]',
      'enabled = false',
      'endpoint = ""',
      '',
      '[auth]',
      'session_ttl_minutes = 60',
      'cookie_secure = false',
      '',
    ].join('\n')
  );
  await writeFile(
    path.join(SANDBOX_CWD, 'README.md'),
    '# demo-app\n\nA tiny service. Configuration lives in `config/settings.toml`.\n'
  );
  return { cwd: SANDBOX_CWD, files: ['config/settings.toml', 'README.md'] };
}

// ---------------------------------------------------------------------------
// Phases 3/4 - real turns (SPEND QUOTA)
// ---------------------------------------------------------------------------

type Arm = {
  label: string;
  logFile: string;
  prompt: string;
  /** null => omit collaborationMode entirely (what S1 did) */
  mode: 'plan' | 'default' | null;
  features: string[];
  /** `-c key=value` overrides passed to the app-server process. */
  configOverrides: string[];
  /**
   * Answer the Nth (0-based) `item/tool/requestUserInput` with `{answers:{}}`
   * instead of real picks. This is the wire equivalent of our
   * `question.respond {cancel:true}` and the only way to learn whether an empty
   * answer map resumes the turn or parks it forever.
   */
  emptyAnswerAt?: number;
};

/**
 * THE ACTUAL TOGGLE. Found by probing the config deserializer with
 * `codex debug prompt-input -c ...` (free, no model call):
 *   `tools.experimental_request_user_input` is a STRUCT (not a bool), and it
 *   has a boolean field `enabled` --
 *     -c tools.experimental_request_user_input=true
 *       => "invalid type: boolean `true`, expected struct ExperimentalRequestUserInput"
 *     -c 'tools.experimental_request_user_input={enabled="bogus"}'
 *       => "invalid type: string \"bogus\", expected a boolean
 *           in `tools.experimental_request_user_input.enabled`"
 * The `features.default_mode_request_user_input` flag is a SECOND, narrower gate
 * that only governs whether the tool is offered in Default collaboration mode.
 */
const REQUEST_USER_INPUT_CONFIG = 'tools.experimental_request_user_input={enabled=true}';

/**
 * Answers a captured `item/tool/requestUserInput` by picking the FIRST option of
 * every question. Free-text questions (`isOther`) get a literal string. The
 * response shape is `{answers:{[questionId]:{answers:string[]}}}`.
 */
function answerQuestions(params: unknown): Record<string, unknown> {
  const p = params as {
    questions?: Array<{
      id: string;
      header?: string;
      question: string;
      options?: Array<{ label: string; description?: string }> | null;
      isOther?: boolean;
      isSecret?: boolean;
    }>;
  };
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of p.questions ?? []) {
    const first = q.options?.[0]?.label;
    answers[q.id] = { answers: [first ?? `probe-answer for ${q.id}`] };
  }
  return { answers };
}

async function runArm(arm: Arm): Promise<Record<string, unknown>> {
  const srv = new AppServer(arm.logFile, [
    ...arm.features.flatMap((f) => ['--enable', f]),
    ...arm.configOverrides.flatMap((c) => ['-c', c]),
  ]);
  const captured: Array<{ method: string; params: unknown; response: unknown; tMs: number }> = [];

  let questionSeq = 0;
  srv.serverRequestHandler = async (req) => {
    let response: unknown = {};
    switch (req.method) {
      case 'item/tool/requestUserInput':
        response =
          questionSeq++ === arm.emptyAnswerAt ? { answers: {} } : answerQuestions(req.params);
        break;
      case 'item/commandExecution/requestApproval':
        response = { decision: 'approved' };
        break;
      case 'item/fileChange/requestApproval':
        response = { decision: 'denied' };
        break;
      case 'item/permissions/requestApproval':
        // Grant nothing; we only want the request shape.
        response = { permissions: {}, scope: 'turn' };
        break;
      case 'mcpServer/elicitation/request':
        response = { action: 'decline' };
        break;
      default:
        response = {};
    }
    captured.push({ method: req.method, params: req.params, response, tMs: req.tMs });
    await log(arm.logFile, {
      dir: '!!',
      tMs: ms(),
      raw: { capturedServerRequest: req.method, params: req.params, answeredWith: response },
    });
    return response;
  };

  try {
    const init = await srv.handshake();
    const thread = (await srv.request('thread/start', {
      cwd: SANDBOX_CWD,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: MODEL,
    })) as Record<string, unknown>;
    const threadId =
      ((thread.thread as Record<string, unknown> | undefined)?.id as string | undefined) ??
      (thread.threadId as string | undefined);

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: arm.prompt }],
    };
    if (arm.mode) {
      turnParams.collaborationMode = { mode: arm.mode, settings: { model: MODEL } };
    }

    const started = performance.now();
    await srv.request('turn/start', turnParams);
    let stopped: string;
    try {
      await srv.waitFor((m) => m === 'turn/completed' || m === 'turn/failed' || m === 'error');
      stopped = 'observed';
    } catch (e) {
      stopped = `timeout: ${String(e)}`;
    }
    const latencyMs = Math.round(performance.now() - started);

    const byMethod: Record<string, number> = {};
    for (const n of srv.notes) byMethod[n.method] = (byMethod[n.method] ?? 0) + 1;
    const completed = srv.notes.find((n) => n.method === 'turn/completed')?.params;
    const failed = srv.notes.find((n) => n.method === 'turn/failed')?.params;

    return {
      arm: arm.label,
      ok: true,
      stopped,
      latencyMs,
      init,
      threadId,
      notificationCounts: byMethod,
      notificationOrder: srv.notes.map((n) => n.method),
      serverRequestMethods: srv.serverRequests.map((r) => r.method),
      capturedServerRequests: captured,
      turnCompleted: completed,
      turnFailed: failed,
      /** Final assistant text, for judging whether it asked in prose instead. */
      agentMessages: srv.notes
        .filter((n) => n.method === 'item/completed')
        .map((n) => (n.params as Record<string, unknown>)?.item)
        .filter((i) => (i as Record<string, unknown>)?.type === 'agentMessage'),
      stderr: srv.stderr.join('').slice(0, 4000),
    };
  } catch (e) {
    return {
      arm: arm.label,
      ok: false,
      error: String(e),
      stderr: srv.stderr.join('').slice(0, 4000),
    };
  } finally {
    srv.kill();
  }
}

// ---------------------------------------------------------------------------
// Phase 6 - ZERO-QUOTA tool-registry capture
//
// The only question that matters after a miss is "was `request_user_input` even
// in the tools array we sent to the model?", and answering it by driving real
// turns is the expensive way. Instead point the provider `base_url` at a local
// sinkhole that logs the outbound /v1/responses body and answers 400. Codex
// builds the full request (instructions + tools) before it ever gets a token
// back, so the tool registry is observable for free.
// ---------------------------------------------------------------------------

type Sinkhole = { port: number; bodies: unknown[]; close: () => void };

async function startSinkhole(): Promise<Sinkhole> {
  const http = await import('node:http');
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        bodies.push({ url: req.url, body: JSON.parse(raw) });
      } catch {
        bodies.push({ url: req.url, raw });
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 's2 sinkhole: capture only', type: 'probe' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, bodies, close: () => server.close() };
}

async function phaseToolRegistry(
  variants: Array<{ label: string; mode: 'plan' | 'default' | null; extra: string[] }>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const v of variants) {
    const sink = await startSinkhole();
    const srv = new AppServer(`phase6-tools-${v.label}.jsonl`, [
      '--enable',
      'default_mode_request_user_input',
      '-c',
      `model_providers.OpenAI.base_url=http://127.0.0.1:${sink.port}/v1`,
      '-c',
      'model_providers.OpenAI.request_max_retries=0',
      '-c',
      'model_providers.OpenAI.stream_max_retries=0',
      ...v.extra.flatMap((c) => ['-c', c]),
    ]);
    try {
      await srv.handshake();
      const thread = (await srv.request('thread/start', {
        cwd: SANDBOX_CWD,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        model: MODEL,
      })) as Record<string, unknown>;
      const threadId =
        ((thread.thread as Record<string, unknown> | undefined)?.id as string | undefined) ??
        (thread.threadId as string | undefined);
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: 'hi' }],
      };
      if (v.mode) turnParams.collaborationMode = { mode: v.mode, settings: { model: MODEL } };
      void srv.request('turn/start', turnParams, 30_000).catch(() => {});
      const deadline = Date.now() + 30_000;
      while (sink.bodies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // MEASURED: gpt-5.6-sol has `tool_mode: "code_mode_only"` +
      // `use_responses_lite: true`, so the Responses request carries NO
      // top-level `tools` array at all. The tool registry rides inside the
      // FIRST input item, `{type:"additional_tools", role:"developer", tools:[...]}`.
      // Reading `body.tools` reports an empty registry and is wrong.
      const body = sink.bodies[0] as {
        body?: {
          tools?: Array<{ name?: string; type?: string }>;
          input?: Array<{ type?: string; tools?: Array<{ name?: string; type?: string }> }>;
        };
      };
      const tools =
        body?.body?.tools ??
        body?.body?.input?.find((i) => i.type === 'additional_tools')?.tools ??
        [];
      out[v.label] = {
        captured: sink.bodies.length,
        toolNames: tools.map((t) => t.name ?? t.type),
        hasRequestUserInput: tools.some((t) => t.name === 'request_user_input'),
        requestUserInputSpec: tools.find((t) => t.name === 'request_user_input') ?? null,
      };
      await writeFile(
        path.join(OUT_DIR, `phase6-request-${v.label}.json`),
        JSON.stringify(sink.bodies[0] ?? null, null, 2)
      );
    } catch (e) {
      out[v.label] = { error: String(e) };
    } finally {
      srv.kill();
      sink.close();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    codexHome: CODEX_HOME,
    cwd: SANDBOX_CWD,
    model: MODEL,
    phases: [...PHASES],
  };

  if (PHASES.has('1')) report.contract = await phaseContract();
  if (PHASES.has('2')) report.fixture = await phaseFixture();
  if (PHASES.has('3')) {
    // MEASURED MISS: feature flag alone, no `tools.*` config -> the model asked
    // in PROSE (a markdown TOML block with `?` placeholders) and the turn ended
    // `turn/completed`. Zero server->client requests. Keeps the negative control.
    report.planArmFlagOnly = await runArm({
      label: 'plan-mode+featureFlagOnly',
      logFile: 'phase3-plan-arm.jsonl',
      prompt: QUESTION_PROMPT,
      mode: 'plan',
      features: ['default_mode_request_user_input'],
      configOverrides: [],
    });
  }
  if (PHASES.has('4')) {
    report.planArmConfigOn = await runArm({
      label: 'plan-mode+toolsConfig',
      logFile: 'phase4-plan-config-arm.jsonl',
      prompt: QUESTION_PROMPT,
      mode: 'plan',
      features: ['default_mode_request_user_input'],
      configOverrides: [REQUEST_USER_INPUT_CONFIG],
    });
  }
  if (PHASES.has('5')) {
    report.defaultArm = await runArm({
      label: 'default-mode+toolsConfig+flag',
      logFile: 'phase5-default-arm.jsonl',
      prompt: DEFAULT_ARM_PROMPT,
      mode: 'default',
      features: ['default_mode_request_user_input'],
      configOverrides: [REQUEST_USER_INPUT_CONFIG],
    });
  }

  if (PHASES.has('6')) {
    report.toolRegistry = await phaseToolRegistry([
      { label: 'plan-bare', mode: 'plan', extra: [] },
      { label: 'plan-toolsCfg', mode: 'plan', extra: [REQUEST_USER_INPUT_CONFIG] },
      { label: 'default-toolsCfg', mode: 'default', extra: [REQUEST_USER_INPUT_CONFIG] },
      {
        label: 'plan-toolsCfg-noCodeMode',
        mode: 'plan',
        extra: [REQUEST_USER_INPUT_CONFIG, 'features.code_mode_host=false'],
      },
      // U4 probe: is the v2 `request_permissions` tool (the thing behind
      // `item/permissions/requestApproval`) offered at all on this build/model?
      {
        label: 'default-requestPermissionsTool',
        mode: 'default',
        extra: [
          'features.request_permissions_tool=true',
          'features.exec_permission_approvals=true',
        ],
      },
    ]);
  }

  if (PHASES.has('7')) {
    report.forcedArm = await runArm({
      label: 'plan-mode+forcedPrompt',
      logFile: 'phase7-forced-arm.jsonl',
      prompt: FORCED_PROMPT,
      mode: 'plan',
      features: ['default_mode_request_user_input'],
      configOverrides: [REQUEST_USER_INPUT_CONFIG],
    });
  }

  if (PHASES.has('8')) {
    report.emptyAnswerArm = await runArm({
      label: 'plan-mode+emptyAnswerFirst',
      logFile: 'phase8-empty-answer-arm.jsonl',
      prompt: FORCED_PROMPT,
      mode: 'plan',
      features: ['default_mode_request_user_input'],
      configOverrides: [REQUEST_USER_INPUT_CONFIG],
      emptyAnswerAt: 0,
    });
  }

  report.finishedAt = new Date().toISOString();
  // One report file per phase set: reruns must never clobber a paid arm's data.
  const tag = [...PHASES].join('-');
  await writeFile(path.join(OUT_DIR, `report-${tag}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
