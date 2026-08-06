/**
 * S1 spike: measure the real cost of talking to Codex CLI *directly*, i.e.
 * WITHOUT going through @agentclientprotocol/codex-acp. This is the control
 * arm for the ACP-route decision (open-q #1).
 *
 * codex 0.145.0 exposes three programmable entry points; this probe evaluates
 * all three and then drives the most capable one for real:
 *   - `codex exec --json`   one-shot, JSONL events on stdout, stdin is the prompt
 *   - `codex app-server`    experimental bidirectional JSON-RPC over stdio  <-- winner
 *   - `codex mcp-server`    stdio MCP; Codex-as-a-tool, not Codex-as-a-host
 *
 * KEY FINDING (2026-08-06, codex-cli 0.145.0):
 *   `codex app-server generate-json-schema --experimental --out DIR` and
 *   `... generate-ts --out DIR` emit the FULL protocol contract from the binary
 *   itself. No reverse engineering is needed: 126 client->server methods,
 *   70 server->client notifications, 11 server->client *requests* (the approval
 *   callbacks). Framing is newline-delimited JSON-RPC 2.0 (NOT LSP
 *   Content-Length); server frames omit the `jsonrpc` field on responses.
 *
 * Phases (each can be skipped; see env vars):
 *   1 SCHEMA   generate + inventory the protocol contract           (offline, free)
 *   2 CATALOG  `codex debug models` + app-server model/list,
 *              permissionProfile/list, collaborationMode/list       (no model spend)
 *   3 TURN     minimal real turn ("reply PONG only") over app-server (SPENDS QUOTA)
 *   4 APPROVAL induce approval callbacks; two arms, `untrusted` and
 *              `on-request`, because they yield DIFFERENT shapes         (SPENDS QUOTA)
 *   5 EXEC     minimal real turn over `codex exec --json`                (SPENDS QUOTA)
 *
 * MEASURED (2026-08-06, gpt-5.6-sol via the third-party responses proxy):
 *   phase 3  turn latency 4.6s, 11 notification kinds, `item/agentMessage/delta`
 *            streams real deltas ("P","ONG"), `thread/tokenUsage/updated` carries
 *            full usage incl. cached/reasoning token split.
 *   phase 4  `untrusted` + read-only  -> `item/commandExecution/requestApproval`
 *            carrying `availableDecisions` (the server tells the client which
 *            buttons to render) and `proposedExecpolicyAmendment`. Under
 *            `untrusted` the agent may NOT escalate, so apply_patch is refused
 *            outright with no callback.
 *            `on-request` + read-only -> `item/fileChange/requestApproval`, which
 *            is THIN (threadId/turnId/itemId/reason/grantRoot only). The diff
 *            arrives separately on `item/started` for the matching `fileChange`
 *            item, so a client MUST correlate by itemId to render the patch.
 *            Both arms raise `thread/status/changed activeFlags:["waitingOnApproval"]`
 *            before the request and emit `serverRequest/resolved` after the answer.
 *   phase 5  `codex exec --json` is COARSE: only thread.started / turn.started /
 *            item.completed / turn.completed, snake_case, dot-separated method
 *            names — a different vocabulary from app-server's slash-separated
 *            camelCase. No deltas, and no channel at all for approvals.
 *
 * Every byte on the wire is appended to <outDir>/<phase>.jsonl with a
 * {dir:'->'|'<-', tMs, raw} envelope, so the raw traffic is auditable after
 * the fact (engineering standard #2: structured trace per run).
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s1-codex-direct-probe.ts
 *
 * Env:
 *   S1_OUT_DIR=<path>       where raw jsonl + schema land (default: os.tmpdir()/s1-direct)
 *   S1_PHASES=1,2           comma list; default "1,2" (dry, no quota spend)
 *                           use "1,2,3,4,5" for the full paid run
 *   S1_CODEX_BIN=<path>     default: `codex` from PATH
 *   S1_TIMEOUT_MS=120000
 */

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CODEX_BIN = process.env.S1_CODEX_BIN ?? 'codex';
const OUT_DIR = process.env.S1_OUT_DIR ?? path.join(os.tmpdir(), 's1-direct');
const TIMEOUT_MS = Number(process.env.S1_TIMEOUT_MS ?? 120_000);
const PHASES = new Set((process.env.S1_PHASES ?? '1,2').split(',').map((s) => s.trim()));

/** Minimal-cost prompt: one token of output, no tools. */
const PONG_PROMPT = 'Reply with exactly PONG and nothing else. Do not use any tools.';
/**
 * Forces a sandbox ESCAPE, which is what actually triggers an approval callback.
 * A plain read-only command (e.g. `id -un`) does NOT: it succeeds inside the
 * read-only sandbox, so Codex never asks. Writes do escape, and file creation
 * additionally exercises the apply_patch path, so this prompt asks for both to
 * capture the command-approval and file-change-approval shapes in one turn.
 */
const APPROVAL_PROMPT =
  process.env.S1_APPROVAL_PROMPT ??
  'Do exactly these two things, in order, without asking me anything first. ' +
    '(1) Use your shell tool to run: echo hi > probe_a.txt . ' +
    '(2) Create a new file probe_b.txt whose entire content is the single word hi. ' +
    'Do not do anything else.';
/** Under `on-request` the agent MAY escalate, which is the only way to see the
 *  file-change (apply_patch) approval shape. Under `untrusted` it is refused. */
const PATCH_APPROVAL_PROMPT =
  process.env.S1_PATCH_PROMPT ??
  'Create a new file named probe_b.txt in the current directory whose entire content is the single word hi. Do not do anything else and do not ask me first.';
/** Stop answering `decline` after this many approvals; `cancel` bounds quota spend. */
const APPROVAL_DECLINE_BUDGET = Number(process.env.S1_APPROVAL_BUDGET ?? 4);

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

type Envelope = { dir: '->' | '<-' | '!!'; tMs: number; raw: unknown };

async function log(file: string, env: Envelope): Promise<void> {
  await appendFile(path.join(OUT_DIR, file), `${JSON.stringify(env)}\n`);
}

// ---------------------------------------------------------------------------
// app-server client: newline-delimited JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Every server->client notification, in arrival order. */
  readonly notes: Array<{ method: string; params: unknown }> = [];
  /** Every server->client *request* (approvals, elicitations, tool calls). */
  readonly serverRequests: Array<{ id: unknown; method: string; params: unknown }> = [];
  /** Answers the probe gives to server requests, keyed by method. */
  serverRequestHandler: ((method: string, params: unknown) => unknown) | null = null;

  private logFile: string;

  constructor(logFile: string, configOverrides: string[] = []) {
    this.logFile = logFile;
    const args = ['app-server', ...configOverrides.flatMap((c) => ['-c', c])];
    this.child = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
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
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : null;

    if (hasId && method) {
      // Server -> client REQUEST (approval / elicitation / dynamic tool call).
      this.serverRequests.push({ id: msg.id, method, params: msg.params });
      const result = this.serverRequestHandler?.(method, msg.params);
      this.send({ id: msg.id, result: result ?? {} });
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
    if (method) this.notes.push({ method, params: msg.params });
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

  /** Resolves when a notification matching `pred` arrives (or times out). */
  waitFor(pred: (m: string, p: unknown) => boolean, timeoutMs = TIMEOUT_MS): Promise<void> {
    const seen = this.notes.length;
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
      clientInfo: { name: 's1-codex-direct-probe', title: 'S1 spike', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
    return res;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Phase 1 - protocol contract inventory (offline)
// ---------------------------------------------------------------------------

function methodsOf(schema: Record<string, unknown>): string[] {
  const variants = (schema.oneOf ?? schema.anyOf ?? []) as Array<Record<string, unknown>>;
  const out: string[] = [];
  for (const v of variants) {
    const props = (v.properties ?? {}) as Record<string, Record<string, unknown>>;
    const m = props.method;
    const c = (m?.const ?? (m?.enum as string[] | undefined)?.[0]) as string | undefined;
    if (c) out.push(c);
  }
  return out.sort();
}

async function phaseSchema(): Promise<Record<string, unknown>> {
  const dir = path.join(OUT_DIR, 'schema');
  await mkdir(dir, { recursive: true });
  await execFileAsync(CODEX_BIN, [
    'app-server',
    'generate-json-schema',
    '--experimental',
    '--out',
    dir,
  ]);
  const read = async (f: string) =>
    JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Record<string, unknown>;

  const clientRequest = methodsOf(await read('ClientRequest.json'));
  const serverRequest = methodsOf(await read('ServerRequest.json'));
  const serverNote = methodsOf(await read('ServerNotification.json'));
  const threadStart = await read(path.join('v2', 'ThreadStartParams.json'));
  const defs = (threadStart.definitions ?? {}) as Record<string, Record<string, unknown>>;

  const v2Count = (await readdir(path.join(dir, 'v2'))).length;

  return {
    clientRequestMethods: clientRequest.length,
    serverRequestMethods: serverRequest,
    serverNotificationMethods: serverNote.length,
    v2TypeFiles: v2Count,
    // Capability probes: does a method/notification exist for each feature we need?
    capability: {
      streamingText: serverNote.includes('item/agentMessage/delta'),
      reasoning:
        serverNote.includes('item/reasoning/textDelta') &&
        serverNote.includes('item/reasoning/summaryTextDelta'),
      toolCalls: serverNote.includes('item/started') && serverNote.includes('item/completed'),
      commandOutputDelta: serverNote.includes('item/commandExecution/outputDelta'),
      execApproval: serverRequest.includes('item/commandExecution/requestApproval'),
      patchApproval: serverRequest.includes('item/fileChange/requestApproval'),
      permissionApproval: serverRequest.includes('item/permissions/requestApproval'),
      askUserQuestion: serverRequest.includes('item/tool/requestUserInput'),
      mcpElicitation: serverRequest.includes('mcpServer/elicitation/request'),
      tokenUsage: serverNote.includes('thread/tokenUsage/updated'),
      resume: clientRequest.includes('thread/resume'),
      fork: clientRequest.includes('thread/fork'),
      compact: clientRequest.includes('thread/compact/start'),
      interrupt: clientRequest.includes('turn/interrupt'),
      steer: clientRequest.includes('turn/steer'),
      modelList: clientRequest.includes('model/list'),
      plan: serverNote.includes('turn/plan/updated'),
      diff: serverNote.includes('turn/diff/updated'),
    },
    approvalPolicyValues: defs.AskForApproval,
    sandboxModeValues: defs.SandboxMode,
    approvalsReviewerValues: defs.ApprovalsReviewer,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 - model / permission catalogs (no model spend)
// ---------------------------------------------------------------------------

async function phaseCatalog(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // (a) offline bundled catalog
  try {
    const { stdout } = await execFileAsync(CODEX_BIN, ['debug', 'models'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { models: Array<Record<string, unknown>> };
    await writeFile(path.join(OUT_DIR, 'debug-models.json'), stdout);
    out.debugModels = {
      ok: true,
      count: parsed.models.length,
      slugs: parsed.models.map((m) => m.slug),
    };
  } catch (e) {
    out.debugModels = { ok: false, error: String(e) };
  }

  // (b) live catalogs over app-server
  const srv = new AppServer('phase2-catalog.jsonl');
  try {
    await srv.handshake();
    for (const [key, method] of [
      ['modelList', 'model/list'],
      ['permissionProfiles', 'permissionProfile/list'],
      ['collaborationModes', 'collaborationMode/list'],
    ] as const) {
      try {
        out[key] = await srv.request(method, {}, 30_000);
      } catch (e) {
        out[key] = { error: String(e) };
      }
    }
  } finally {
    srv.kill();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 3 - minimal real turn over app-server (SPENDS QUOTA)
// ---------------------------------------------------------------------------

async function phaseTurn(cwd: string): Promise<Record<string, unknown>> {
  const srv = new AppServer('phase3-turn.jsonl');
  try {
    const init = await srv.handshake();
    const thread = (await srv.request('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })) as Record<string, unknown>;
    const threadId = (thread.thread as Record<string, unknown> | undefined)?.id ?? thread.threadId;

    const started = performance.now();
    await srv.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PONG_PROMPT }],
    });
    await srv.waitFor((m) => m === 'turn/completed' || m === 'error', TIMEOUT_MS);
    const latencyMs = Math.round(performance.now() - started);

    const byMethod: Record<string, number> = {};
    for (const n of srv.notes) byMethod[n.method] = (byMethod[n.method] ?? 0) + 1;

    const sample = (m: string) => srv.notes.find((n) => n.method === m)?.params;
    const completed = srv.notes.find((n) => n.method === 'turn/completed')?.params as
      | Record<string, unknown>
      | undefined;

    return {
      ok: true,
      init,
      threadId,
      latencyMs,
      notificationCounts: byMethod,
      samples: {
        threadStarted: sample('thread/started'),
        turnStarted: sample('turn/started'),
        itemStarted: sample('item/started'),
        agentMessageDelta: sample('item/agentMessage/delta'),
        reasoningDelta:
          sample('item/reasoning/textDelta') ?? sample('item/reasoning/summaryTextDelta'),
        itemCompleted: sample('item/completed'),
        tokenUsage: sample('thread/tokenUsage/updated'),
        turnCompleted: completed,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    srv.kill();
  }
}

// ---------------------------------------------------------------------------
// Phase 4 - approval callback shape (SPENDS QUOTA)
// ---------------------------------------------------------------------------

async function phaseApproval(
  cwd: string,
  opts: { policy: string; prompt: string; logFile: string }
): Promise<Record<string, unknown>> {
  // Config overrides only; the user's ~/.codex/config.toml is never touched.
  const srv = new AppServer(opts.logFile, [
    `approval_policy="${opts.policy}"`,
    'sandbox_mode="read-only"',
  ]);
  const seen: Array<{ method: string; params: unknown }> = [];
  // Deny so nothing actually executes; the *shape* is what we are after.
  // Two decision dialects coexist in 0.145.0:
  //   legacy `execCommandApproval`/`applyPatchApproval` -> ReviewDecision
  //     ("approved" | "approved_for_session" | {denied:{rejection}} | "abort" | ...)
  //   v2 `item/*/requestApproval` -> per-kind enums
  //     ("accept" | "acceptForSession" | "decline" | "cancel" | ...)
  // `cancel` also interrupts the turn, which bounds quota spend for this probe.
  srv.serverRequestHandler = (method, params) => {
    seen.push({ method, params });
    const overBudget = seen.length > APPROVAL_DECLINE_BUDGET;
    switch (method) {
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return {
          decision: overBudget
            ? 'abort'
            : { denied: { rejection: 's1 probe: shape capture only' } },
        };
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: overBudget ? 'cancel' : 'decline' };
      case 'item/tool/requestUserInput': {
        const qs = ((params as Record<string, unknown>)?.questions ?? []) as Array<{ id: string }>;
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of qs) answers[q.id] = { answers: ['s1 probe'] };
        return { answers };
      }
      default:
        return {};
    }
  };
  try {
    await srv.handshake();
    const thread = (await srv.request('thread/start', {
      cwd,
      approvalPolicy: opts.policy,
      sandbox: 'read-only',
    })) as Record<string, unknown>;
    const threadId = (thread.thread as Record<string, unknown> | undefined)?.id ?? thread.threadId;

    await srv.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: opts.prompt }],
    });
    await srv.waitFor((m) => m === 'turn/completed' || m === 'error', TIMEOUT_MS);

    return {
      ok: true,
      policy: opts.policy,
      threadStartEcho: {
        approvalPolicy: thread.approvalPolicy,
        sandbox: thread.sandbox,
        activePermissionProfile: thread.activePermissionProfile,
      },
      approvalRequestCount: seen.length,
      approvalRequests: seen,
      allServerRequests: srv.serverRequests.map((r) => r.method),
    };
  } catch (e) {
    return { ok: false, error: String(e), approvalRequests: seen };
  } finally {
    srv.kill();
  }
}

// ---------------------------------------------------------------------------
// Phase 5 - minimal real turn over `codex exec --json` (SPENDS QUOTA)
// ---------------------------------------------------------------------------

async function phaseExec(cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-C',
      cwd,
      PONG_PROMPT,
    ];
    const child = spawn(CODEX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now();
    const kinds: Record<string, number> = {};
    const firstOf: Record<string, unknown> = {};
    let buf = '';
    let stderr = '';
    let nonJsonLines = 0;

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      buf += c;
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          void log('phase5-exec.jsonl', { dir: '<-', tMs: ms(), raw: ev });
          const kind =
            (ev.type as string) ??
            ((ev.msg as Record<string, unknown> | undefined)?.type as string) ??
            'unknown';
          kinds[kind] = (kinds[kind] ?? 0) + 1;
          if (!(kind in firstOf)) firstOf[kind] = ev;
        } catch {
          nonJsonLines++;
          void log('phase5-exec.jsonl', { dir: '!!', tMs: ms(), raw: { nonJson: line } });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        latencyMs: Math.round(performance.now() - started),
        eventKinds: kinds,
        nonJsonLines,
        samples: firstOf,
        stderrTail: stderr.slice(-1500),
      });
    });
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const sandboxCwd = path.join(OUT_DIR, 'sandbox');
  await mkdir(sandboxCwd, { recursive: true });

  const report: Record<string, unknown> = { outDir: OUT_DIR, phases: [...PHASES] };

  if (PHASES.has('1')) {
    console.log('[phase 1] protocol contract inventory ...');
    report.schema = await phaseSchema().catch((e) => ({ error: String(e) }));
  }
  if (PHASES.has('2')) {
    console.log('[phase 2] model / permission catalogs ...');
    report.catalog = await phaseCatalog().catch((e) => ({ error: String(e) }));
  }
  if (PHASES.has('3')) {
    console.log('[phase 3] minimal real turn over app-server (SPENDS QUOTA) ...');
    report.turn = await phaseTurn(sandboxCwd);
  }
  if (PHASES.has('4')) {
    console.log('[phase 4] approval callback shape (SPENDS QUOTA) ...');
    // Two runs: `untrusted` never allows escalation (so apply_patch is refused
    // outright and only the command-approval shape appears), while `on-request`
    // does allow it and is the only way to observe the file-change shape.
    report.approvalUntrusted = await phaseApproval(sandboxCwd, {
      policy: 'untrusted',
      prompt: APPROVAL_PROMPT,
      logFile: 'phase4a-approval-untrusted.jsonl',
    });
    report.approvalOnRequest = await phaseApproval(sandboxCwd, {
      policy: 'on-request',
      prompt: PATCH_APPROVAL_PROMPT,
      logFile: 'phase4b-approval-onrequest.jsonl',
    });
  }
  if (PHASES.has('5')) {
    console.log('[phase 5] minimal real turn over `codex exec --json` (SPENDS QUOTA) ...');
    report.exec = await phaseExec(sandboxCwd);
  }

  // Per-phase file too: report.json only ever holds the LAST run's phases,
  // and the paid phases are normally run one at a time.
  const outFile = path.join(OUT_DIR, 'report.json');
  await writeFile(outFile, JSON.stringify(report, null, 2));
  await writeFile(
    path.join(OUT_DIR, `report-phases-${[...PHASES].join('')}.json`),
    JSON.stringify(report, null, 2)
  );
  console.log(`\n=== S1 DIRECT-CODEX REPORT (also at ${outFile}) ===`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

void main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
