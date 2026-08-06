/**
 * S1 spike: can `@agentclientprotocol/codex-acp` be driven from this machine
 * with a HAND-WRITTEN, dependency-free JSON-RPC-over-stdio client, and what
 * does the real ACP event stream look like?
 *
 * Why hand-written: the open question S1 has to price is "what does it cost to
 * speak ACP ourselves". Using an ACP client library would hide exactly the cost
 * we are trying to measure, so this probe implements the newline-delimited
 * JSON-RPC 2.0 framing directly (~120 lines, see AcpClient below).
 *
 * Ground truth used here comes from the installed packages, not from docs:
 *   - method table:      @agentclientprotocol/sdk  ->  `methods` export
 *   - request shapes:    @agentclientprotocol/sdk  ->  schema/schema.json
 *   - PROTOCOL_VERSION:  1
 *   - session modes:     codex-acp dist/index.js -> src/AgentMode.ts
 *                        read-only | agent (default) | agent-full-access
 *   - codex binary:      codex-acp spawns `@openai/codex/bin/codex.js app-server`
 *                        (BUNDLED) unless env CODEX_PATH is set.
 *
 * Scenarios:
 *   A minimal-turn        default mode ("agent"), real ~/.codex, "reply PONG only".
 *                         Measures cold start -> initialize and the full
 *                         initialize/session_new/prompt round trip.
 *   B permission (read)   read-only mode + a READ shell command. Control: proves
 *                         reads inside the sandbox policy are auto-approved.
 *   C permission (write)  read-only mode + a WRITE shell command. This is the one
 *                         that forces `session/request_permission`. The probe
 *                         answers REJECT, so nothing is executed for real.
 *
 * RESULT (2026-08-06, node v24.18.0, codex-acp 1.1.9, @agentclientprotocol/sdk
 * 1.3.0, bundled @openai/codex 0.145.0, gpt-5.6-sol via the third-party
 * responses-API proxy configured in ~/.codex/config.toml):
 *   - Hand-written client is enough: ~120 lines of framing + a request handler
 *     completed a real turn. No ACP client library needed.
 *   - NO `authenticate` call was required. initialize advertises
 *     authMethods [api-key, chat-gpt] but returns no "not authenticated" flag,
 *     and session/new + session/prompt worked straight away off
 *     ~/.codex/auth.json (OPENAI_API_KEY).
 *   - Cold start spawn -> initialize response: 178-188 ms. session/new: 88-90 ms.
 *     Minimal PONG turn: 4585 ms end to end. Agent answered exactly "PONG".
 *   - Process chain (verified with ps --forest): codex-acp(node) ->
 *     node node_modules/@openai/codex/bin/codex.js app-server ->
 *     node_modules/@openai/codex-linux-x64/vendor/.../bin/codex app-server.
 *     The PATH `codex` is NOT used unless env CODEX_PATH is set.
 *   - session/update variants actually observed: agent_message_chunk,
 *     agent_thought_chunk, tool_call, tool_call_update, available_commands_update,
 *     session_info_update, usage_update. (Schema declares 13; `plan`,
 *     `plan_update`, `plan_removed`, `current_mode_update`, `config_option_update`,
 *     `user_message_chunk` did not appear in these runs.)
 *   - session/request_permission carries 4 options for an exec approval:
 *     allow_once / allow_always / accept_execpolicy_amendment(allow_always) /
 *     reject_once, plus a fat `_meta.codex` block (raw codex decision enums,
 *     execpolicy amendment argv, reason string). Rejecting yields
 *     tool_call_update status "failed" with exit_code null.
 *   - Agent->client requests use their own id space and START AT id 0.
 *   - Even with clientCapabilities.terminal=false the agent still emitted
 *     tool_call content [{type:"terminal", terminalId}] — a client must tolerate
 *     terminal references it cannot query.
 *
 * Every frame in both directions is appended to <root>/traffic.jsonl as
 * {ts, elapsedMs, scenario, dir: "c2a" | "a2c", frame}.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s1-acp-codex-probe.ts
 *
 * Optional env:
 *   AICLIENT_S1_ACP_ROOT=<dir>        # npm root holding node_modules/@agentclientprotocol/codex-acp
 *   AICLIENT_S1_SCENARIOS=A,B,C       # subset (default A,B,C)
 *   AICLIENT_S1_CODEX_HOME=<dir>      # CODEX_HOME for scenario C; REQUIRED there,
 *                                     # see the note next to scenario C below
 *   AICLIENT_S1_TIMEOUT_MS=180000
 *   AICLIENT_S1_CWD=<dir>             # session cwd (default <root>/sandbox)
 *   AICLIENT_S1_TRAFFIC=<file>        # default <root>/traffic.jsonl
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ACP_ROOT =
  process.env.AICLIENT_S1_ACP_ROOT ??
  '/tmp/claude-1000/-home-dan-projects-ai-client/cfb85aab-ccf6-449b-b420-22ad961c2d6e/scratchpad/s1-acp';
const AGENT_ENTRY = path.join(
  ACP_ROOT,
  'node_modules/@agentclientprotocol/codex-acp/dist/index.js'
);
const SESSION_CWD = process.env.AICLIENT_S1_CWD ?? path.join(ACP_ROOT, 'sandbox');
const TRAFFIC_FILE = process.env.AICLIENT_S1_TRAFFIC ?? path.join(ACP_ROOT, 'traffic.jsonl');
const TIMEOUT_MS = Number(process.env.AICLIENT_S1_TIMEOUT_MS ?? 180_000);
const SCENARIOS = (process.env.AICLIENT_S1_SCENARIOS ?? 'A,B,C').split(',').map((s) => s.trim());

/** ACP protocol version advertised by @agentclientprotocol/sdk 1.3.x. */
const PROTOCOL_VERSION = 1;

const PROMPT_PONG = '只回复 PONG，不要做任何别的事。';
/**
 * B used a READ command on purpose (control): in read-only mode a read command
 * is inside the sandbox policy, so it is auto-approved and NO permission
 * request is emitted. C uses a WRITE command, which escapes the read-only
 * sandbox and is what actually forces `session/request_permission`.
 */
const PROMPT_PERMISSION =
  'Run the shell command `ls -a` in the current directory using your shell tool, then stop. Do not do anything else.';
const PROMPT_PERMISSION_WRITE =
  'The user explicitly authorizes you to create a file in the current directory. ' +
  'Call your shell tool exactly once with this command: echo probe > acp-probe-marker.txt ' +
  'Then reply DONE. Do not explain, do not ask, do not use any other tool.';

type Frame = Record<string, unknown>;

interface TrafficEntry {
  ts: string;
  elapsedMs: number;
  scenario: string;
  dir: 'c2a' | 'a2c' | 'stderr';
  frame: unknown;
}

/**
 * Minimal ACP client: newline-delimited JSON-RPC 2.0 over the agent's stdio.
 * This is the whole "cost of speaking ACP ourselves" for the transport layer.
 */
class AcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buf = '';
  private readonly t0 = performance.now();
  stderrTail = '';
  readonly notifications: Frame[] = [];
  readonly incomingRequests: Frame[] = [];

  private readonly scenario: string;
  /** Handles agent -> client requests; returns the JSON-RPC `result`. */
  private readonly onRequest: (method: string, params: Frame) => unknown;

  constructor(
    scenario: string,
    env: NodeJS.ProcessEnv,
    onRequest: (method: string, params: Frame) => unknown
  ) {
    this.scenario = scenario;
    this.onRequest = onRequest;
    this.child = spawn(process.execPath, [AGENT_ENTRY], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-16_384);
      this.log('stderr', chunk.trimEnd());
    });
  }

  private log(dir: TrafficEntry['dir'], frame: unknown): void {
    const entry: TrafficEntry = {
      ts: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.t0),
      scenario: this.scenario,
      dir,
      frame,
    };
    appendFileSync(TRAFFIC_FILE, `${JSON.stringify(entry)}\n`);
  }

  private consume(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Frame;
      try {
        msg = JSON.parse(line) as Frame;
      } catch {
        this.log('a2c', { unparsable: line.slice(0, 2000) });
        continue;
      }
      this.log('a2c', msg);
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Frame): void {
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;
    if (method && id === undefined) {
      this.notifications.push(msg);
      return;
    }
    if (method && id !== undefined) {
      // agent -> client request
      this.incomingRequests.push(msg);
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      try {
        result = this.onRequest(method, (msg.params ?? {}) as Frame);
      } catch (err) {
        error = { code: -32601, message: (err as Error).message };
      }
      this.send(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
      return;
    }
    if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private send(frame: Frame): void {
    this.log('c2a', frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: Frame): Promise<unknown> {
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method} after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS).unref?.();
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  notify(method: string, params: Frame): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 1500).unref?.();
  }
}

/** Client capabilities we advertise. fs/terminal on = we must serve those methods. */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

interface ScenarioResult {
  label: string;
  ok: boolean;
  failedStep: string | null;
  error: string | null;
  spawnToInitializeMs: number | null;
  sessionNewMs: number | null;
  promptMs: number | null;
  initializeResult: unknown;
  sessionId: string | null;
  stopReason: unknown;
  updateKinds: Record<string, number>;
  updateSamples: Record<string, unknown>;
  agentToClientRequests: { method: string; count: number }[];
  permissionRequests: unknown[];
  agentText: string;
  stderrTail: string;
  exitCode: number | null;
}

async function runScenario(
  label: string,
  extraEnv: NodeJS.ProcessEnv,
  prompt: string
): Promise<ScenarioResult> {
  const res: ScenarioResult = {
    label,
    ok: false,
    failedStep: null,
    error: null,
    spawnToInitializeMs: null,
    sessionNewMs: null,
    promptMs: null,
    initializeResult: null,
    sessionId: null,
    stopReason: null,
    updateKinds: {},
    updateSamples: {},
    agentToClientRequests: [],
    permissionRequests: [],
    agentText: '',
    stderrTail: '',
    exitCode: null,
  };

  const permissionRequests: Frame[] = [];
  const requestCounts = new Map<string, number>();

  const client = new AcpClient(label, { ...process.env, ...extraEnv }, (method, params) => {
    requestCounts.set(method, (requestCounts.get(method) ?? 0) + 1);
    if (method === 'session/request_permission') {
      permissionRequests.push(params);
      const options = (params.options ?? []) as { optionId: string; kind: string }[];
      // Reject so nothing actually executes on this machine.
      const reject =
        options.find((o) => o.kind === 'reject_once') ??
        options.find((o) => o.kind?.startsWith('reject')) ??
        options[options.length - 1];
      return { outcome: { outcome: 'selected', optionId: reject?.optionId } };
    }
    if (method === 'fs/read_text_file') return { content: '' };
    if (method === 'fs/write_text_file') return {};
    throw new Error(`unhandled agent->client request: ${method}`);
  });

  const spawnAt = performance.now();
  try {
    let step = 'initialize';
    res.initializeResult = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'ai-client-s1-probe', version: '0.0.1' },
    });
    res.spawnToInitializeMs = Math.round(performance.now() - spawnAt);

    // authenticate only if initialize says we must and advertises a method.
    const init = res.initializeResult as {
      authMethods?: { id: string }[];
      isAuthenticated?: boolean;
      authenticated?: boolean;
    };
    const needsAuth = init.isAuthenticated === false || init.authenticated === false;
    if (needsAuth && init.authMethods?.length) {
      step = 'authenticate';
      await client.request('authenticate', { methodId: init.authMethods[0].id });
    }

    step = 'session/new';
    const t1 = performance.now();
    const session = (await client.request('session/new', {
      cwd: SESSION_CWD,
      mcpServers: [],
    })) as { sessionId: string };
    res.sessionNewMs = Math.round(performance.now() - t1);
    res.sessionId = session.sessionId;

    step = 'session/prompt';
    const t2 = performance.now();
    const promptRes = (await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })) as { stopReason?: unknown };
    res.promptMs = Math.round(performance.now() - t2);
    res.stopReason = promptRes.stopReason ?? promptRes;
    res.ok = true;
    void step;
  } catch (err) {
    res.error = (err as Error).message;
    res.failedStep =
      res.spawnToInitializeMs === null
        ? 'initialize'
        : res.sessionId === null
          ? 'session/new'
          : 'session/prompt';
  }

  // Tally session/update variants + keep one truncated sample of each.
  for (const n of client.notifications) {
    if (n.method !== 'session/update') continue;
    const params = n.params as { update?: { sessionUpdate?: string } };
    const kind = params?.update?.sessionUpdate ?? '<no sessionUpdate>';
    res.updateKinds[kind] = (res.updateKinds[kind] ?? 0) + 1;
    if (!(kind in res.updateSamples)) {
      res.updateSamples[kind] = JSON.parse(JSON.stringify(params).slice(0, 100_000));
    }
    if (kind === 'agent_message_chunk') {
      const c = (params.update as { content?: { text?: string } }).content;
      if (c?.text) res.agentText += c.text;
    }
  }
  res.agentToClientRequests = [...requestCounts].map(([method, count]) => ({ method, count }));
  res.permissionRequests = permissionRequests;
  res.stderrTail = client.stderrTail.slice(-4000);

  client.close();
  await new Promise((r) => setTimeout(r, 500));
  res.exitCode = client.child.exitCode;
  return res;
}

function truncate(v: unknown, max = 700): unknown {
  const s = JSON.stringify(v);
  if (s === undefined) return v;
  return s.length <= max ? v : `${s.slice(0, max)}…<truncated ${s.length} chars>`;
}

async function main(): Promise<void> {
  mkdirSync(SESSION_CWD, { recursive: true });
  writeFileSync(TRAFFIC_FILE, '');

  const results: ScenarioResult[] = [];
  if (SCENARIOS.includes('A')) {
    results.push(await runScenario('A_minimal_turn', {}, PROMPT_PONG));
  }
  if (SCENARIOS.includes('B')) {
    results.push(
      await runScenario('B_permission', { INITIAL_AGENT_MODE: 'read-only' }, PROMPT_PERMISSION)
    );
  }
  if (SCENARIOS.includes('C')) {
    // AICLIENT_S1_CODEX_HOME points at a stripped ~/.codex clone. Needed because
    // the real ~/.codex/config.toml carries `developer_instructions` that forbid
    // unrequested edits, so the model refuses the write command outright and no
    // approval is ever reached (measured: C against the real CODEX_HOME ended
    // with stopReason=end_turn and ZERO tool_call updates).
    const codexHome = process.env.AICLIENT_S1_CODEX_HOME;
    results.push(
      await runScenario(
        'C_permission_write',
        codexHome
          ? { INITIAL_AGENT_MODE: 'read-only', CODEX_HOME: codexHome }
          : { INITIAL_AGENT_MODE: 'read-only' },
        PROMPT_PERMISSION_WRITE
      )
    );
  }

  const a = results.find((r) => r.label === 'A_minimal_turn');
  const b =
    results.find((r) => r.label === 'C_permission_write') ??
    results.find((r) => r.label === 'B_permission');
  const verdict = {
    /** Did the hand-written client complete a real turn? */
    minimalTurnCompleted: a ? a.ok : null,
    /** Did the agent actually answer PONG? */
    pongEchoed: a ? /PONG/i.test(a.agentText) : null,
    coldStartToInitializeMs: a?.spawnToInitializeMs ?? null,
    /** Did read-only mode force a permission round trip? */
    permissionRequestObserved: b ? b.permissionRequests.length > 0 : null,
    sessionUpdateKindsSeen: [...new Set(results.flatMap((r) => Object.keys(r.updateKinds)))].sort(),
    agentToClientMethodsSeen: [
      ...new Set(results.flatMap((r) => r.agentToClientRequests.map((x) => x.method))),
    ].sort(),
  };

  const out = {
    probe: 's1-acp-codex',
    acpRoot: ACP_ROOT,
    agentEntry: AGENT_ENTRY,
    sessionCwd: SESSION_CWD,
    trafficFile: TRAFFIC_FILE,
    protocolVersion: PROTOCOL_VERSION,
    verdict,
    scenarios: results.map((r) => ({
      ...r,
      initializeResult: truncate(r.initializeResult, 4000),
      updateSamples: Object.fromEntries(
        Object.entries(r.updateSamples).map(([k, v]) => [k, truncate(v, 900)])
      ),
      permissionRequests: r.permissionRequests.map((p) => truncate(p, 2500)),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = verdict.minimalTurnCompleted ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
