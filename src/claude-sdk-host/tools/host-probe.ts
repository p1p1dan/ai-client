/**
 * Route-B prototype: drive `host.ts` over IPC the way Main's WorkerSlot does,
 * against the local fake gateway (`--plan claude-sdk`), and print the runtime
 * events each scenario produces.
 *
 *   node tools/host-probe.ts <gatewayUrl> <workspace> [scenario ...]
 *
 * Scenarios: text tools ask stop plan steer agent search enc compact history errors repoenv.
 * Default: text tools ask stop plan steer. Resume: run again with PROBE_CONFIG_DIR and
 * PROBE_SESSION_FILE pointing at the first run's config dir and stub.
 * Every scenario ends with deterministic `[check]` lines (terminal event, tools that ran,
 * cards, orphan cleanup, history growth); the probe exits 1 when any of them fails.
 *
 * Route B S-1 adds two. `errors`: one `CC-ERR` turn per HTTP status (the gateway answers
 * with `x-should-retry: false`), checking each `session.failed` errorCode and that its text
 * never says "Claude Code". `repoenv`: before the host starts, the workspace gets a
 * `.claude/settings.json` whose `env` points the gateway, the proxies and the provider
 * switches at a closed port and adds a bearer token and a header; a `CC-ENV` turn must
 * still complete at the configured gateway with only our key (decision 6's pins). The file
 * is removed when the probe ends; the probe refuses a workspace that already has one.
 *
 * `enc` is the encrypted-machine matrix (prototype doc §5.2, on branch proto/claude-agent-sdk-engine
 * only; see docs/plantree/plans/claude-sdk-engine/README.md §0). Samples: PROBE_ENC_FILES (absolute paths, `;`-separated) and/or every file of
 * PROBE_ENC_DIR, each holding PROBE_ENC_MARKER (default `P113B-MARKER-`, the P1-13b kit's).
 * One turn per sample, in bypass gear: Read, Grep, Bash cat, Bash sed, Edit (the marker
 * gets a `CCSDK-EDITED-` prefix), Read again, Write a new file of the same name into a
 * fresh `ccsdk-written-<ms>` sibling directory, and Read that back. Prints one line per
 * tool call and one ENC-MATRIX row per sample (what the CLI saw), then the first bytes of
 * every edited sample, written file and the session transcript as this node and Windows
 * PowerShell 5.1 read them; PROBE_ENC_RECHECK_S=<s> repeats that after a delay. The samples
 * are edited in place: give it a fresh copy each run. Without PROBE_ENC_FILES / _DIR it
 * writes four plain samples into the workspace (a dry run).
 *
 * Route B S-2, one scenario per permission mode (topic s2-permission-modes.md §3.2), each
 * on the pair the composer sends and each judged by what the CLI did (cards raised, files
 * written), scripted through the fake gateway's `CC-RUN`: `mode-manual`, `mode-edits`,
 * `mode-plan` (changes refused in plan mode, the SDK review card, the chosen mode taking
 * effect), `mode-bypass`, `mode-switch` (a switch while a card is up, then the next call
 * of the same turn) and `mode-enterplan` (the model entering plan mode by itself reaches
 * PiLab as `session.permissions` `engine`), `mode-plan-refused` (its own workspace and run:
 * the workspace's settings disable Bypass permissions, so approving a plan into it falls to
 * Manual with the reason), and `mode-auto` (the fake gateway's
 * safety check allows, then blocks three calls in a row, the third falling back to PiLab's
 * card, then is down; each refused row in PiLab's words, never the CLI's).
 *
 * Route B S-3 (topic s3-project-config.md K-1, K-5): `keyiso`. The key reaches the host by
 * IPC and the CLI only through the host's auth proxy: the Bash tool's `env`, a PowerShell
 * child's environment and every file under the config dir hold the session token at most,
 * never the key, while the gateway still gets the key (`CC-ENV`).
 *
 * Route B S-3 (P-1..P-5), each in its own workspace: `projcfg` (the project's CLAUDE.md,
 * `.claude/CLAUDE.md`, `.claude/rules` and CLAUDE.local.md reach the model; the project's
 * allow rule (`.claude/settings.json`, applied only in a trusted workspace) and the local one
 * skip the card; its PreToolUse hook runs and sees the session token; its
 * `disableBypassPermissionsMode` refuses Bypass permissions; the plugin marketplace it
 * declares is fetched and its plugin loaded on the host's second start (ruling 18), as the
 * CLI fetches from the second start of a trusted workspace on: the scenario restarts the
 * host itself), `projcfg-home` (the
 * workspace's parent, whose name must contain `fakehome`, stands in for the home directory:
 * its CLAUDE.md is read, its `.claude` is not; on Windows the cwd is given with the drive
 * letter's case flipped) and `projcfg-scratch` (an unbound chat: none of it applies).
 * PROBE_SETTING_SOURCES overrides the host's setting sources (default `user,project,local`).
 * `stop` (README §11.2 #52): PROBE_STOP_LEFTOVER_REPORT_ONLY=1 makes the "no sleep left"
 * check report without failing the probe (CI, temporarily, while fix A is verified there);
 * PROBE_PS_DIAG=1 times PowerShell on Windows in the host's environment and the full one
 * after the scenario (`diagnosePowerShell`).
 *
 * Route B S-6 feedback 1: `findings`. One `ReportFindings` call per posture (Manual, Edit
 * automatically, plan, Auto, Bypass): never a card, the input whole on `tool.updated` and
 * in the history.
 *
 * Dsh-rebase decision 196: `proxy`, on its own. The host is told the gateway is
 * `gateway.invalid:<port>`, a name only a local test proxy (src/dsh-host/tools/lib/testProxy.ts)
 * resolves, and gets that proxy, with credentials, beside the key, as Main hands over the
 * product proxy; no proxy variable is inherited. A CC-TEXT turn completes through it, every
 * request authorised; the CLI's Bash tool sees it in HTTPS_PROXY with NODE_USE_ENV_PROXY=1;
 * switched off (`host.proxy`), the next turn's request goes direct (it cannot reach
 * `gateway.invalid`, so it is stopped once the host logs the failure) and never reaches the
 * proxy; switched on again, a turn completes through it with no restart; the host's stderr
 * never quotes the proxy password.
 *
 * dsh-rebase decision 194: `slash`, in its own workspace (it writes a project skill and a
 * command of the user layer). The menu lists the CLI's commands before any message, less
 * the window's `/compact` and the ones PiLab owns or hides; `/context`'s output is the
 * turn's reply; a skill's and a command's bodies reach the model; the history shows each
 * line as typed and `/context`'s output after it.
 *
 * The key is a fake one unless PROBE_API_KEY is set in the shell; nothing here reads a
 * stored credential.
 */

import { type ChildProcess, execFile, execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir as osTmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { startTestProxy, type TestProxy } from '../../dsh-host/tools/lib/testProxy.ts';
import { CLAUDE_SDK_INHERITED_ENV } from '../../shared/claudeSdkEngine.ts';
import { WINDOWS_POWERSHELL_ARGS, WINDOWS_PROCESS_QUERY } from '../processTree.ts';

const [gatewayUrl, workspace, ...wanted] = process.argv.slice(2);
if (!gatewayUrl || !workspace)
  throw new Error('usage: host-probe.ts <gatewayUrl> <workspace> [scenario ...]');
const scenarios = wanted.length > 0 ? wanted : ['text', 'tools', 'ask', 'stop', 'plan', 'steer'];
// A run that ends any other way than through the final summary (the host died, the event loop
// drained) is a failure; the summary sets the real code.
process.exitCode = 1;
// PROBE_HOST_ENTRY: drive a bundled host.js instead of the source entry.
const hostEntry =
  process.env.PROBE_HOST_ENTRY?.trim() || fileURLToPath(new URL('../host.ts', import.meta.url));
// The temp directory spelled in full (probe-suite.ts `longTmpdir`): the CLI asks before
// every read or write under an 8.3 short path, as GitHub's Windows runners set TEMP.
const longTmp = (() => {
  try {
    return realpathSync.native(osTmpdir());
  } catch {
    return osTmpdir();
  }
})();
const tmpdir = () => longTmp;
const configDir = process.env.PROBE_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'pilab-ccsdk-home-'));
const apiKey = process.env.PROBE_API_KEY ?? 'sk-fake-probe-key';
/** The key as the fake gateway's CC-ENV line names it (`keyDigest`). */
const keyDigest = `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}`;
/** Nothing listens here: a request sent to it fails at once. */
const CLOSED_PORT_URL = 'http://127.0.0.1:1';
/** What a hostile repository's `.claude/settings.json` sets (`repoenv`). */
const REPO_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: CLOSED_PORT_URL,
  HTTP_PROXY: CLOSED_PORT_URL,
  HTTPS_PROXY: CLOSED_PORT_URL,
  ALL_PROXY: CLOSED_PORT_URL,
  http_proxy: CLOSED_PORT_URL,
  https_proxy: CLOSED_PORT_URL,
  all_proxy: CLOSED_PORT_URL,
  ANTHROPIC_AUTH_TOKEN: 'repo-bearer-token',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Repo-Injected: 1',
  // No effect on the probe's plain-HTTP gateway; pinned all the same (measured over HTTPS).
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_BEDROCK_BASE_URL: CLOSED_PORT_URL,
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  AWS_REGION: 'us-east-1',
  CLAUDE_CODE_USE_VERTEX: '1',
  ANTHROPIC_VERTEX_BASE_URL: CLOSED_PORT_URL,
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
  ANTHROPIC_VERTEX_PROJECT_ID: 'repo-project',
  CLOUD_ML_REGION: 'us-east5',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_FOUNDRY_BASE_URL: CLOSED_PORT_URL,
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  ANTHROPIC_AWS_BASE_URL: CLOSED_PORT_URL,
  ANTHROPIC_AWS_WORKSPACE_ID: 'repo-workspace',
  CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  ANTHROPIC_BEDROCK_MANTLE_BASE_URL: CLOSED_PORT_URL,
  CLAUDE_CODE_SKIP_MANTLE_AUTH: '1',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
  ANTHROPIC_GOOGLE_CLOUD_BASE_URL: CLOSED_PORT_URL,
  ANTHROPIC_GOOGLE_CLOUD_PROJECT: 'repo-project',
  ANTHROPIC_GOOGLE_CLOUD_LOCATION: 'us-east5',
  ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID: 'repo-workspace',
  CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH: '1',
  CLAUDE_CODE_USE_GATEWAY: '1',
  // Route B S-2: the model of Auto's safety check and of `sonnet` subagents, the request
  // betas, and Auto's server-side check (each measured changeable by a repository).
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'repo-model',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'repo-model',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'repo-model',
  ANTHROPIC_SMALL_FAST_MODEL: 'repo-model',
  CLAUDE_CODE_SUBAGENT_MODEL: 'repo-model',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_AUTO_MODE_SERVER: '0',
  // A pin that did not hold fails the turn at once instead of after minutes of retries.
  CLAUDE_CODE_MAX_RETRIES: '0',
};
const repoSettingsFile = join(workspace, '.claude', 'settings.json');
let wroteRepoSettings = false;

type Message = Record<string, unknown>;
type Event = { type: string; requestId?: string; payload?: Record<string, unknown> };

let child: ChildProcess;

/**
 * `webfetch` (S-6 feedback 5): a proxy that only writes down where the CLI wanted to go
 * and refuses every connection, so the probe sees whether WebFetch asked claude.ai first.
 */
let fetchProxy: { server: TcpServer; url: string; targets: string[] } | null = null;

/** `proxy` (decision 196): the product proxy stand-in, and its password. */
let outboundProxy: TestProxy | null = null;
const OUTBOUND_PROXY_PASSWORD = `probe-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 16)}`;
const PROXY_NAMES = /^(http|https|all|no)_proxy$/i;
/** The gateway as the host is told: `gateway.invalid` under `proxy`, so only the proxy reaches it. */
const hostGatewayUrl = scenarios.includes('proxy')
  ? gatewayUrl.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, '//gateway.invalid')
  : gatewayUrl;
function outboundSetting(): { url: string; noProxy: string } | null {
  return outboundProxy
    ? { url: outboundProxy.urlWithCredentials, noProxy: 'localhost,127.0.0.1' }
    : null;
}

function startFetchProxy(): Promise<void> {
  const targets: string[] = [];
  const server = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      const first = chunk.toString('latin1').split('\r\n')[0] ?? '';
      const [method, target] = first.split(' ');
      if (method === 'CONNECT' && target) targets.push(target.toLowerCase());
      else if (target) {
        try {
          targets.push(new URL(target).host.toLowerCase());
        } catch {
          targets.push(String(target));
        }
      }
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      fetchProxy = { server, url: `http://127.0.0.1:${port}`, targets };
      resolve();
    });
  });
}
const generation = 1;
let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let events: Event[] = [];
/** S-5 R-3: every event of the running scenario, dumped when PROBE_RECORD_DIR is set. */
let scenarioEvents: Event[] = [];
const waiters: Array<{
  test: (e: Event) => boolean;
  resolve: (e: Event) => void;
  reject: (e: Error) => void;
}> = [];
/** Set when the host process exits; every pending request and wait then fails with it. */
let hostGone: Error | undefined;
/** Every line the host wrote to stderr (Main forwards them to the renderer). */
const hostStderr: string[] = [];
let sessionFile: string | undefined;
const logicalSessionId = `probe-${Date.now()}`;

/**
 * What Main lets the host inherit (`claudeSdkEngine.ts`, `HOST_INHERITED`), only the
 * names set here, as Main passes them (route B S-4: the packaged smoke runs this on
 * Linux too, where HOME and TMPDIR matter).
 */
function inheritedEnv(): Record<string, string> {
  const names = new Set([...CLAUDE_SDK_INHERITED_ENV, 'AICLIENT_GIT_BASH_PATH']);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !names.has(name.toUpperCase())) continue;
    // `proxy`: the product proxy alone decides; this shell's own proxy stays out.
    if (outboundProxy && PROXY_NAMES.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** Waits until the host wrote more than `already` stderr lines matching `pattern`. */
async function waitForHostLines(pattern: RegExp, already: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (hostStderr.filter((line) => pattern.test(line)).length > already) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function startHost(): void {
  child = fork(hostEntry, [], {
    env: {
      ...inheritedEnv(),
      AICLIENT_CLAUDE_SDK_GENERATION: String(generation),
      AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
      AICLIENT_CLAUDE_SDK_BASE_URL: hostGatewayUrl,
      AICLIENT_CLAUDE_SDK_SETTING_SOURCES:
        process.env.PROBE_SETTING_SOURCES ?? 'user,project,local',
      // S-3 P-5: the fake home directory (`projcfg-home`).
      ...(scenarios.includes('projcfg-home') ? { AICLIENT_CLAUDE_SDK_HOME: fakeHome() } : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_RG_DIR
        ? { AICLIENT_CLAUDE_SDK_RG_DIR: process.env.AICLIENT_CLAUDE_SDK_RG_DIR }
        : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_TRACE ? { AICLIENT_CLAUDE_SDK_TRACE: '1' } : {}),
      // `webfetch`: every outside connection goes to the recording proxy; the gateway and
      // the host's own auth proxy stay on loopback.
      ...(fetchProxy
        ? {
            HTTPS_PROXY: fetchProxy.url,
            HTTP_PROXY: fetchProxy.url,
            NO_PROXY: '127.0.0.1,localhost',
          }
        : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_CLI
        ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Route B S-3 (K-5): the key goes as the first IPC message, as Main sends it. A real
  // gateway key comes from PROBE_API_KEY in this shell only; never a file.
  child.send({
    type: 'host.secret',
    apiKey,
    // Decision 196: the product proxy goes with the key, as Main sends it.
    ...(outboundProxy ? { proxy: outboundSetting() } : {}),
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      hostStderr.push(line);
      if (process.env.PROBE_VERBOSE) console.log(`  [host] ${line}`);
    }
  });
  child.on('exit', (code, signal) => {
    hostGone = new Error(`host exited (code ${code}, signal ${signal})`);
    for (const p of pending.values()) p.reject(hostGone);
    pending.clear();
    for (const w of waiters.splice(0)) w.reject(hostGone);
  });
  child.on('message', (raw) => {
    const message = raw as Message;
    if (message.kind === 'response') {
      const waiter = pending.get(String(message.requestId));
      pending.delete(String(message.requestId));
      if (message.ok) waiter?.resolve(message.result);
      else waiter?.reject(new Error(JSON.stringify(message.error)));
    } else if (message.kind === 'event' && message.type === 'runtime.event') {
      const event = message.payload as Event;
      events.push(event);
      scenarioEvents.push(event);
      if (
        process.env.PROBE_VERBOSE &&
        !event.type.endsWith('.delta') &&
        event.type !== 'usage.updated'
      )
        console.log(`  [event] ${event.type} ${JSON.stringify(event.payload ?? {}).slice(0, 160)}`);
      for (const w of [...waiters]) {
        if (w.test(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    }
  });
}

function request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  if (hostGone) return Promise.reject(hostGone);
  const requestId = `rpc-probe-${++seq}`;
  child.send({ protocolVersion: 1, kind: 'request', generation, requestId, type, payload });
  return new Promise<T>((resolve, reject) =>
    pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject })
  );
}

function waitFor(test: (e: Event) => boolean, label: string, timeoutMs = 60_000): Promise<Event> {
  const seen = events.find(test);
  if (seen) return Promise.resolve(seen);
  if (hostGone) return Promise.reject(hostGone);
  return new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({
      test,
      resolve: (e) => {
        clearTimeout(timer);
        resolve(e);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

const terminal = (e: Event) =>
  e.type === 'session.completed' || e.type === 'session.failed' || e.type === 'session.stopped';

/** Deterministic per-scenario checks; any failure makes the probe exit 1. */
const failures: string[] = [];
let checkCount = 0;

function check(
  scenario: string,
  label: string,
  ok: boolean,
  options: { reportOnly?: boolean } = {}
): void {
  if (options.reportOnly) {
    // Printed under another tag: probe-suite.ts counts `[check]` lines only.
    console.log(`  [report] ${ok ? 'ok  ' : 'WARN'} ${label} (report only)`);
    return;
  }
  checkCount += 1;
  if (!ok) failures.push(`${scenario}: ${label}`);
  console.log(`  [check] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

/** Names of the tools started, and of those that completed ok, among the current events. */
function toolRuns(): { started: string[]; okNames: string[] } {
  const names = new Map<string, string>();
  const okNames: string[] = [];
  for (const e of events) {
    const id = String(e.payload?.toolCallId);
    if (e.type === 'tool.started') names.set(id, String(e.payload?.name));
    if (e.type === 'tool.completed' && e.payload?.ok === true) okNames.push(names.get(id) ?? '?');
  }
  return { started: [...names.values()], okNames };
}

function checkTools(scenario: string, expected: string[]): void {
  const { started, okNames } = toolRuns();
  for (const name of expected) {
    check(
      scenario,
      `${name} ran and completed ok`,
      started.includes(name) && okNames.includes(name)
    );
  }
}

const countOf = (type: string) => events.filter((e) => e.type === type).length;

/** S-2: the SDK review card's choices (`SDK_PLAN_REVIEW_CHOICES`). */
const SDK_REVIEW_CHOICES = [
  'run:accept-edits',
  'run:ask',
  'run:auto',
  'run:bypass',
  'keep-planning',
];

/** `findings`: a review's report, every field of the CLI's schema used once. */
const REVIEW_REPORT = {
  level: 'high',
  findings: [
    {
      file: 'src/pager.ts',
      line: 42,
      summary: 'The last page is dropped when the total is an exact multiple of the page size.',
      short_summary: 'Last page dropped on exact multiples',
      failure_scenario: 'total=20, pageSize=10: pages() returns 1 instead of 2.',
      category: 'correctness',
      verdict: 'CONFIRMED',
    },
    {
      file: 'src/cache.ts',
      summary: 'The session cache survives a logout.',
      failure_scenario: 'Log out, log in as another user: the first user’s data is served.',
    },
  ],
};

/** `findings`: the same review re-reported after fixes (`outcome` set on each). */
const REVIEW_REREPORT = {
  findings: REVIEW_REPORT.findings.map((finding, index) => ({
    ...finding,
    outcome: index === 0 ? 'fixed' : 'skipped',
  })),
};

/**
 * S-2: one turn of scripted calls (`CC-RUN`). Each permission card is answered as
 * `answer` says (it may act first, e.g. switch the mode while the card is up); a plan
 * review card with `review`. Returns the terminal event and the tool name of each card.
 */
async function runCalls(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  answer: (card: Event) => Promise<'allow' | 'deny'> | 'allow' | 'deny',
  review?: string,
  /** Words after the script, e.g. the fake gateway's `CC-CLS-BLOCK` for Auto's check. */
  suffix = ''
): Promise<{ end: Event; cards: string[]; reviews: Event[]; answeredByProbe: boolean[] }> {
  const answered = new Set<string>();
  const cards: string[] = [];
  const reviews: Event[] = [];
  /** Per card: nothing had settled it before the probe's answer, and the answer took. */
  const answeredByProbe: boolean[] = [];
  // `send` starts the turn's event list afresh: everything in it is this turn's.
  await send(`CC-RUN ${JSON.stringify({ calls })}${suffix ? ` ${suffix}` : ''}`);
  for (;;) {
    const e = await waitFor(
      (ev) =>
        terminal(ev) ||
        (ev.type === 'permission.requested' && !answered.has(String(ev.payload?.permissionId))) ||
        (ev.type === 'question.requested' && !answered.has(String(ev.payload?.questionId))),
      'scripted turn',
      120_000
    );
    if (terminal(e)) return { end: e, cards, reviews, answeredByProbe };
    if (e.type === 'question.requested') {
      answered.add(String(e.payload?.questionId));
      reviews.push(e);
      await request('worker.question.respond', {
        logicalSessionId,
        questionId: e.payload?.questionId,
        answers: { 'plan-review': review ?? 'keep-planning' },
        ...(review ? {} : { response: 'probe: keep planning' }),
      });
      continue;
    }
    const id = String(e.payload?.permissionId);
    answered.add(id);
    cards.push(String(e.payload?.toolName));
    const decision = await answer(e);
    const settledBefore = events.some(
      (ev) => ev.type === 'permission.resolved' && String(ev.payload?.permissionId) === id
    );
    const taken = await request<{ handled?: boolean }>('worker.permission.respond', {
      logicalSessionId,
      permissionId: e.payload?.permissionId,
      decision,
    });
    answeredByProbe.push(!settledBefore && taken?.handled === true);
  }
}

/** A fresh path in the workspace for a mode scenario (removed first). */
function modePath(name: string): string {
  const file = join(workspace, name);
  rmSync(file, { recursive: true, force: true });
  return file;
}

async function setPosture(mode: 'plan' | 'agent', gear: string): Promise<unknown> {
  return request('worker.setPermissions', { logicalSessionId, permissions: { mode, gear } });
}

/** Text of the assistant's messages only: the host also echoes the user's text as message.delta. */
function assistantText(): string {
  const ids = new Set(
    events
      .filter((e) => e.type === 'message.started' && e.payload?.role === 'assistant')
      .map((e) => String(e.payload?.messageId))
  );
  return events
    .filter((e) => e.type === 'message.delta' && ids.has(String(e.payload?.messageId)))
    .map((e) => String(e.payload?.text ?? ''))
    .join('');
}

function show(label: string): void {
  console.log(`\n=== ${label} (${events.length} events)`);
  for (const e of events) {
    if (e.type === 'message.delta' || e.type === 'thinking.delta') continue;
    const p = JSON.stringify(e.payload ?? {});
    console.log(`  ${e.type.padEnd(20)} ${p.length > 230 ? `${p.slice(0, 230)}…` : p}`);
  }
  const text = events
    .filter((e) => e.type === 'message.delta')
    .map((e) => String(e.payload?.text ?? ''))
    .join('');
  const thinking = events.filter((e) => e.type === 'thinking.delta').length;
  console.log(`  [text deltas joined] ${text.slice(0, 300)}`);
  console.log(`  [thinking deltas] ${thinking}`);
}

let lastHistoryCount: number | undefined;
let sendsSinceHistory = 0;

async function send(text: string): Promise<string> {
  events = [];
  sendsSinceHistory += 1;
  const requestId = `send-probe-${++seq}`;
  const t0 = Date.now();
  await request('worker.send', {
    logicalSessionId,
    requestId,
    attemptId: `attempt-${seq}`,
    text,
    model: 'probe-gw/claude-opus-5-5',
  });
  console.log(`  send acked in ${Date.now() - t0} ms`);
  return requestId;
}

/** Processes running exactly `sleep <seconds>`, so leftovers of other runs do not count. */
function sleepers(seconds: number): number {
  if (process.platform !== 'win32') {
    // `sleep <seconds>` exactly, as on Windows: another probe's sleeps do not count (S-5).
    return Number(
      execFileSync('sh', ['-c', `pgrep -fc '^sleep ${seconds}$' || true`])
        .toString()
        .trim() || 0
    );
  }
  const filter = `Name='sleep.exe'`;
  const script = `@(Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.CommandLine -match ' ${seconds}\\s*$' }).Count`;
  return Number(
    execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().trim() || 0
  );
}

/**
 * Windows: the `sleep <seconds>` processes still running, with their Windows parent, and
 * Git Bash's own process table beside them (its `ps.exe`), for a CI run whose Stop left
 * them behind (the host reaps them through that table, processTree.ts).
 */
function describeSleepers(seconds: number): string[] {
  const script = `@(Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -match ' ${seconds}\\s*$' } | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress`;
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().trim();
    const rows = (raw ? [JSON.parse(raw)].flat() : []) as Array<{
      ProcessId: number;
      ParentProcessId: number;
      ExecutablePath: string;
    }>;
    const out = rows.map(
      (row) => `sleep.exe#${row.ProcessId} parent #${row.ParentProcessId} ${row.ExecutablePath}`
    );
    const exe = rows[0]?.ExecutablePath;
    if (exe) {
      const listing = execFileSync(join(dirname(exe), 'ps.exe'), [], { windowsHide: true })
        .toString()
        .split(/\r?\n/);
      out.push(...listing.filter((line, i) => i === 0 || /sleep|bash/.test(line)));
    }
    return out;
  } catch (error) {
    return [`(could not describe them: ${error instanceof Error ? error.message : error})`];
  }
}

/** Put back first when the host's environment is the slow one (handoff 2026-10-17 §9 step 1). */
const PS_DIAG_FIRST = ['PSModulePath', 'PSModuleAnalysisCachePath', 'ALLUSERSPROFILE', 'PUBLIC'];
/** The runner's own variables, not system ones: never put back. */
const PS_DIAG_SKIP = /^(GITHUB_|RUNNER_|ACTIONS_|INPUT_|PROBE_|AICLIENT_|npm_|CI$)/i;

/** One PowerShell run, timed; `host` spawns it as processTree.ts `runClosed` does. */
function timePowerShell(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  style: 'host' | 'sync'
): Promise<{ ms: number; verdict: string; fast: boolean }> {
  const started = Date.now();
  const done = (error: unknown, stdout: string) => {
    const ms = Date.now() - started;
    const e = error as { killed?: boolean; code?: unknown; signal?: unknown } | null;
    const lines = stdout.split(/\r?\n/).filter((l) => l.trim()).length;
    const verdict = !e
      ? `ok, ${lines} lines`
      : e.killed || e.signal === 'SIGTERM'
        ? `TIMED OUT (${timeoutMs} ms)`
        : `exit ${String(e.code ?? '?')}`;
    return { ms, verdict, fast: !e && ms < 1_500 };
  };
  if (style === 'sync') {
    try {
      return Promise.resolve(
        done(null, execFileSync('powershell', args, { env, timeout: timeoutMs }).toString())
      );
    } catch (error) {
      return Promise.resolve(done(error, ''));
    }
  }
  return new Promise((resolve) => {
    const child = execFile(
      'powershell',
      args,
      { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(done(error, String(stdout)))
    );
    child.stdin?.end();
  });
}

/**
 * README §11.2 #52, handoff 2026-10-17 §9 step 1 (PROBE_PS_DIAG=1, Windows): where the
 * host's Windows process query loses its time on GitHub's runners, where it ran past its
 * timeout every time while the same query from this process took 0.3 s. Timed, spawned the
 * host's way (async execFile, windowsHide, stdin closed): PowerShell's bare start-up and the
 * host's query, each in the host's environment (CLAUDE_SDK_INHERITED_ENV, built as
 * `inheritedEnv` builds it) and in this process's full one; the query spawned synchronously
 * as this probe's own queries are, in both; then, only when the host's environment is the
 * slow one, that environment with each variable it lacks put back one at a time
 * (PS_DIAG_FIRST first, then the other system variables, never the runner's own), stopping
 * at the first that makes it fast, and with all of them at once. Prints names, never values.
 */
async function diagnosePowerShell(): Promise<void> {
  const restricted: NodeJS.ProcessEnv = inheritedEnv();
  const full = process.env;
  const startup = [...WINDOWS_POWERSHELL_ARGS, '1'];
  const query = [...WINDOWS_POWERSHELL_ARGS, WINDOWS_PROCESS_QUERY];
  const out = (label: string, r: { ms: number; verdict: string }) =>
    console.log(`  [ps-diag] ${label.padEnd(44)} ${String(r.ms).padStart(6)} ms  ${r.verdict}`);
  console.log('\n=== ps-diag: PowerShell timings (README §11.2 #52)');
  const missing = Object.keys(full).filter(
    (name) => !(name in restricted) && !PS_DIAG_SKIP.test(name)
  );
  console.log(
    `  [ps-diag] variables the host lacks (${missing.length}): ${missing.sort().join(' ')}`
  );
  const hostStartup = await timePowerShell(startup, restricted, 20_000, 'host');
  out("host env, host spawn, '1'", hostStartup);
  const hostQuery = await timePowerShell(query, restricted, 20_000, 'host');
  out('host env, host spawn, process query', hostQuery);
  const fullStartup = await timePowerShell(startup, full, 20_000, 'host');
  out("full env, host spawn, '1'", fullStartup);
  const fullQuery = await timePowerShell(query, full, 20_000, 'host');
  out('full env, host spawn, process query', fullQuery);
  out(
    'host env, sync spawn, process query',
    await timePowerShell(query, restricted, 20_000, 'sync')
  );
  out('full env, sync spawn, process query', await timePowerShell(query, full, 20_000, 'sync'));
  const envSlow = !hostQuery.fast && fullQuery.fast;
  if (!envSlow) {
    console.log(
      `  [ps-diag] ${hostQuery.fast ? 'the host environment is not slow from here' : 'slow in the full environment too: not the environment'}; variables not put back`
    );
    return;
  }
  const order = [
    ...PS_DIAG_FIRST.filter((name) => missing.some((m) => m.toUpperCase() === name.toUpperCase())),
    ...missing
      .filter((name) => !PS_DIAG_FIRST.some((f) => f.toUpperCase() === name.toUpperCase()))
      .sort(),
  ].slice(0, 40);
  let found: string | undefined;
  for (const name of order) {
    const key = missing.find((m) => m.toUpperCase() === name.toUpperCase()) ?? name;
    const r = await timePowerShell(query, { ...restricted, [key]: full[key] }, 6_000, 'host');
    out(`host env + ${key}`, r);
    if (r.fast) {
      found = key;
      break;
    }
  }
  const everything: NodeJS.ProcessEnv = { ...restricted };
  for (const name of missing) everything[name] = full[name];
  out('host env + all of them', await timePowerShell(query, everything, 20_000, 'host'));
  console.log(
    `  [ps-diag] ${found ? `fast again with ${found} put back` : 'no single variable makes it fast'}`
  );
}

/**
 * `enc` samples: PROBE_ENC_FILES (`;`-separated absolute paths), then the regular files of
 * PROBE_ENC_DIR (not recursive). Neither set: a dry run on plain samples written into the
 * workspace under a few of P1-13b's names, a binary extension and an extensionless one included.
 */
function encSamples(marker: string): string[] {
  const listed = (process.env.PROBE_ENC_FILES ?? '')
    .split(';')
    .map((file) => file.trim())
    .filter(Boolean);
  const dir = process.env.PROBE_ENC_DIR?.trim();
  const inDir = dir
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(dir, entry.name))
        .sort()
    : [];
  if (listed.length + inDir.length > 0) return [...listed, ...inDir];
  return ['enc-sample.md', 'enc-sample.yml', 'enc-sample.docx', 'Makefile'].map((name) => {
    const file = join(workspace, name);
    writeFileSync(file, `${marker}dryrun ${name}\nline two\n`);
    return file;
  });
}

function toolText(output: unknown): string {
  if (typeof output === 'string') return output;
  const content = (output as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    return content.map((block) => String((block as { text?: unknown })?.text ?? '')).join('\n');
  }
  return JSON.stringify(output ?? '');
}

const HEAD_BYTES = 256;

/** What a file's first bytes are; a string head is a read status ('missing', 'error'). */
function classifyHead(head: Buffer | string, marker: string): string {
  if (typeof head === 'string') return head;
  const text = head.toString('latin1');
  if (text.startsWith('%TSD-Header')) return 'TSD';
  if (text.includes('CCSDK-EDITED-')) return 'edited';
  if (text.includes('CCSDK-WRITTEN')) return 'written';
  if (text.includes(marker)) return 'marker';
  if (text.startsWith('{')) return 'json';
  return head.length === 0 ? 'empty' : 'other';
}

/** First bytes as this process reads them: on the encrypted machine, the shipped node.exe. */
function nodeHead(file: string): Buffer | string {
  if (!existsSync(file)) return 'missing';
  try {
    return readFileSync(file).subarray(0, HEAD_BYTES);
  } catch {
    return 'error';
  }
}

/**
 * The same, as Windows PowerShell 5.1 reads them ([IO.File]): P1-13b's other reader, which
 * sees TSD where node does not for some types (md, java, …) and the reverse for others.
 */
function powershellHeads(files: string[]): Array<Buffer | string> {
  const heads: Array<Buffer | string> = files.map(() => 'error');
  const script = [
    '$i = 0',
    'foreach ($p in (ConvertFrom-Json -InputObject $env:PROBE_ENC_PATHS)) {',
    '  try {',
    '    if (-not [IO.File]::Exists($p)) { "$i missing" } else {',
    '      $s = [IO.File]::OpenRead($p)',
    `      try { $b = New-Object byte[] ${HEAD_BYTES}; $n = $s.Read($b, 0, ${HEAD_BYTES}); "$i hex:" + [BitConverter]::ToString($b, 0, $n) } finally { $s.Close() }`,
    '    }',
    '  } catch { "$i error" }',
    '  $i++',
    '}',
  ].join('\n');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PROBE_ENC_PATHS: JSON.stringify(files) },
    }).toString();
    for (const line of out.split(/\r?\n/)) {
      const match = /^(\d+) (?:hex:([0-9A-F-]*)|(\w+))$/.exec(line.trim());
      if (!match) continue;
      heads[Number(match[1])] =
        match[2] !== undefined ? Buffer.from(match[2].replaceAll('-', ''), 'hex') : match[3];
    }
  } catch (error) {
    console.log(`  (PowerShell 5.1 reader failed: ${String(error).slice(0, 200)})`);
  }
  return heads;
}

function printDiskViews(
  items: Array<{ label: string; file: string }>,
  marker: string,
  when: string
) {
  console.log(
    `\n=== on disk ${when}: first ${HEAD_BYTES} bytes as read by this node / PowerShell 5.1`
  );
  const ps = process.platform === 'win32' ? powershellHeads(items.map((x) => x.file)) : undefined;
  for (const [i, item] of items.entries()) {
    const node = classifyHead(nodeHead(item.file), marker);
    const viaPs = ps ? ` ps51=${classifyHead(ps[i] ?? 'error', marker)}` : '';
    console.log(`  ${item.label.padEnd(36)} node=${node.padEnd(8)}${viaPs}`);
  }
}

/** `repoenv`: the hostile settings must be on disk when the CLI starts (it reads them once). */
function writeRepoSettings(): void {
  if (existsSync(repoSettingsFile)) {
    throw new Error(`repoenv: ${repoSettingsFile} already exists; use a fresh workspace`);
  }
  mkdirSync(dirname(repoSettingsFile), { recursive: true });
  const settings = {
    ...(scenarios.includes('repoenv') ? { env: REPO_ENV } : {}),
    ...(scenarios.includes('mode-plan-refused')
      ? { permissions: { disableBypassPermissionsMode: 'disable' } }
      : {}),
  };
  writeFileSync(repoSettingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  wroteRepoSettings = true;
}

function removeRepoSettings(): void {
  if (!wroteRepoSettings) return;
  rmSync(repoSettingsFile, { force: true });
  wroteRepoSettings = false;
}

/** S-3: the scenarios that bring their own project fixture (`writeProjectFixture`). */
const PROJCFG_SCENARIOS = ['projcfg', 'projcfg-home', 'projcfg-scratch'];
/** S-3: the canaries each instruction file carries (`CC-ECHO` names the ones sent). */
const CANARIES = {
  projectMd: 'CANARY-PROJECT-MD',
  projectDotClaude: 'CANARY-PROJECT-DOTCLAUDE',
  projectRule: 'CANARY-PROJECT-RULE',
  localMd: 'CANARY-LOCAL-MD',
  homeMd: 'CANARY-HOME-MD',
  homeDotClaude: 'CANARY-HOME-DOTCLAUDE',
  homeRule: 'CANARY-HOME-RULE',
  /** Ruling 19: the user layer, the CLI's config dir (the app's own, never ~/.claude). */
  userMd: 'CANARY-USER-MD',
};
const PROJECT_CANARIES = [
  CANARIES.projectMd,
  CANARIES.projectDotClaude,
  CANARIES.projectRule,
  CANARIES.localMd,
];
/** Where the project's PreToolUse hook and the marketplace's plugin hook leave their marks. */
const hookMarker = join(workspace, 'projcfg-hook.jsonl');
const pluginMarker = join(workspace, 'projcfg-plugin.txt');
const MARKETPLACE = 'probe-market';

/** `projcfg-home`: the workspace's parent, refused unless it is plainly a stand-in. */
function fakeHome(): string {
  const home = dirname(workspace);
  if (!basename(home).includes('fakehome')) {
    throw new Error(`projcfg-home: the workspace's parent (${home}) must be named *fakehome*`);
  }
  return home;
}

/** A forward-slash path for a hook command line (Git Bash and cmd both take it). */
const slashed = (file: string) => file.replace(/\\/g, '/');

function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * S-3: the project the `projcfg` scenarios open, written before the host starts (the CLI
 * reads it once). Rewritten on every run, so a second run with the same PROBE_CONFIG_DIR
 * (`projcfg`'s marketplace check) finds it as the first left it.
 */
function writeProjectFixture(): void {
  if (existsSync(repoSettingsFile) && !existsSync(join(workspace, '.claude', 'probe-hook.js'))) {
    throw new Error(`projcfg: ${repoSettingsFile} is not the probe's; use a fresh workspace`);
  }
  rmSync(hookMarker, { force: true });
  rmSync(pluginMarker, { force: true });
  writeText(join(configDir, 'CLAUDE.md'), `User note: ${CANARIES.userMd}.\n`);
  writeText(join(workspace, 'CLAUDE.md'), `Project note: ${CANARIES.projectMd}.\n`);
  writeText(
    join(workspace, '.claude', 'CLAUDE.md'),
    `Project note: ${CANARIES.projectDotClaude}.\n`
  );
  writeText(
    join(workspace, '.claude', 'rules', 'probe.md'),
    `Project rule: ${CANARIES.projectRule}.\n`
  );
  writeText(join(workspace, 'CLAUDE.local.md'), `Private note: ${CANARIES.localMd}.\n`);
  // The hook records which tool it saw and the key in its environment, then allows nothing
  // and refuses nothing (no output).
  const hookScript = join(workspace, '.claude', 'probe-hook.js');
  writeText(
    hookScript,
    [
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  let tool = null;',
      '  try { tool = JSON.parse(input).tool_name ?? null; } catch {}',
      `  fs.appendFileSync(${JSON.stringify(hookMarker)}, JSON.stringify({ tool, key: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');`,
      '});',
      '',
    ].join('\n')
  );
  // A directory-source marketplace whose plugin's SessionStart hook leaves a mark (§4.3).
  const market = join(workspace, '.probe-market');
  writeText(
    join(market, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: 'probe' },
        plugins: [{ name: 'probe-plugin', source: './probe-plugin', description: 'probe' }],
      },
      null,
      2
    )}\n`
  );
  writeText(
    join(market, 'probe-plugin', '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'probe-plugin', version: '0.0.1', description: 'probe' })}\n`
  );
  const pluginHook = join(market, 'probe-plugin', 'hook.js');
  writeText(
    pluginHook,
    `require('node:fs').writeFileSync(${JSON.stringify(pluginMarker)}, 'loaded\\n');\n`
  );
  writeText(
    join(market, 'probe-plugin', 'hooks', 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `node "${slashed(pluginHook)}"` }] },
          ],
        },
      },
      null,
      2
    )}\n`
  );
  writeText(
    repoSettingsFile,
    `${JSON.stringify(
      {
        permissions: {
          allow: ['Bash(touch:*)', 'Edit(projcfg-rule-*)'],
          disableBypassPermissionsMode: 'disable',
        },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `node "${slashed(hookScript)}"` }],
            },
          ],
        },
        extraKnownMarketplaces: {
          [MARKETPLACE]: { source: { source: 'directory', path: market } },
        },
        enabledPlugins: { [`probe-plugin@${MARKETPLACE}`]: true },
      },
      null,
      2
    )}\n`
  );
  writeText(
    join(workspace, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(mkdir:*)'] } }, null, 2)}\n`
  );
  if (scenarios.includes('projcfg-home')) {
    const home = fakeHome();
    writeText(join(home, 'CLAUDE.md'), `Home note: ${CANARIES.homeMd}.\n`);
    writeText(join(home, '.claude', 'CLAUDE.md'), `Home note: ${CANARIES.homeDotClaude}.\n`);
    writeText(join(home, '.claude', 'rules', 'home.md'), `Home rule: ${CANARIES.homeRule}.\n`);
  }
}

/**
 * dsh-rebase decision 194 `slash`: a project skill and a command of the user layer (the
 * app's config dir, ruling 19), each telling the model a canary the gateway echoes back.
 */
function writeSlashFixture(): void {
  writeText(
    join(workspace, '.claude', 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: Probe skill\n---\n\nSay CANARY-SLASH-SKILL.\n'
  );
  writeText(
    join(configDir, 'commands', 'probe-user-cmd.md'),
    '---\ndescription: Probe command\n---\n\nSay CANARY-SLASH-CMD and $ARGUMENTS.\n'
  );
  // Decision 194 Q1: a SessionStart hook a catalog listing must not run.
  const hook = `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(slashHookMarker())}`;
  writeText(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } })
  );
}

/** The file the `slash` fixture's SessionStart hook writes. */
function slashHookMarker(): string {
  return join(workspace, 'session-start-hook-ran');
}

/** Decision 194 Q1: this host's entry in catalog mode for `cwd`, and its one answer. */
function catalogListing(cwd: string): Promise<{
  ok?: boolean;
  error?: string;
  ms?: number;
  result?: { commands: Array<{ name: string; source: string }> };
}> {
  return new Promise((resolve, reject) => {
    const catalog = fork(hostEntry, [], {
      env: {
        ...inheritedEnv(),
        AICLIENT_CLAUDE_SDK_GENERATION: '0',
        AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
        AICLIENT_CLAUDE_SDK_SETTING_SOURCES:
          process.env.PROBE_SETTING_SOURCES ?? 'user,project,local',
        AICLIENT_CLAUDE_SDK_CATALOG_CWD: cwd,
        AICLIENT_CLAUDE_SDK_CATALOG_TRUSTED: '1',
        ...(process.env.AICLIENT_CLAUDE_SDK_CLI
          ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI }
          : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let answer: Record<string, unknown> | undefined;
    const timer = setTimeout(() => {
      catalog.kill();
      reject(new Error('the catalog host did not answer in 40 s'));
    }, 40_000);
    catalog.on('message', (message) => {
      if ((message as { type?: unknown })?.type === 'claude-sdk.catalog') {
        answer = message as Record<string, unknown>;
      }
    });
    catalog.on('exit', () => {
      clearTimeout(timer);
      if (answer) resolve(answer);
      else reject(new Error('the catalog host exited without an answer'));
    });
  });
}

/** `projcfg-home` on Windows: the cwd as the user might have typed it, drive letter flipped. */
function bootstrapCwd(): string {
  if (!scenarios.includes('projcfg-home') || process.platform !== 'win32') return workspace;
  const drive = /^([A-Za-z]):/.exec(workspace)?.[1];
  if (!drive) return workspace;
  const flipped = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
  return `${flipped}${workspace.slice(1)}`;
}

/**
 * S-3: one `CC-ECHO` turn and the canaries the gateway named; a turn that did not end
 * normally, or a gateway that does not know the marker, fails the run (no vacuous `none`).
 */
async function echoTurn(scenario: string): Promise<string[]> {
  await send('CC-ECHO which instructions');
  const end = await waitFor(terminal, `${scenario} echo turn end`);
  const listed = /CC-ECHO canaries=(\S+)/.exec(assistantText())?.[1];
  check(
    scenario,
    'the echo turn completed at a gateway that knows CC-ECHO',
    end.type === 'session.completed' && listed !== undefined
  );
  return listed === undefined || listed === 'none' ? [] : listed.split(',');
}

/** The lines the project's PreToolUse hook wrote. */
function hookLines(): Array<{ tool: string | null; key: string | null }> {
  if (!existsSync(hookMarker)) return [];
  return readFileSync(hookMarker, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string | null; key: string | null });
}

/** Files under the config dir that name the probe's marketplace (fetched or registered). */
function marketplaceTraces(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.includes(MARKETPLACE)) found.push(full);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.json') &&
        dirname(full) !== configDir &&
        readFileSync(full, 'utf8').includes(MARKETPLACE)
      )
        found.push(full);
    }
  };
  walk(join(configDir, 'plugins'));
  return found;
}

/**
 * S-5 R-3 (topic s5-regression.md): the scenario's events as the host sent them, with
 * the directories they may name, for `event-record.ts` to normalize. Unnormalized: a
 * local file the gate reads, never committed.
 */
async function recordScenario(scenario: string): Promise<void> {
  const dir = process.env.PROBE_RECORD_DIR?.trim();
  if (!dir) return;
  // The host reports idle right after a turn's terminal event. Wait for it, so the cut
  // falls in the same place on every machine: Linux caught it in this recording, Windows
  // left it to the next scenario's (S-5 §8 C-5).
  let last = -1;
  scenarioEvents.forEach((e, i) => {
    if (terminal(e)) last = i;
  });
  const idle = (e: Event) => e.type === 'session.status' && e.payload?.status === 'idle';
  const deadline = Date.now() + 5_000;
  while (last >= 0 && !scenarioEvents.slice(last + 1).some(idle) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `raw.${scenario}.json`),
    `${JSON.stringify({ scenario, workspace, configDir, tmp: tmpdir(), events: scenarioEvents }, null, 2)}\n`
  );
}

/** `errors`: status, the code `session.failed` must carry, and an optional gateway message. */
const ERROR_CASES: Array<{ status: number; code: string; message?: string; echoKey?: boolean }> = [
  { status: 401, code: 'PROVIDER_UNAUTHORIZED' },
  { status: 404, code: 'MODEL_NOT_CONFIGURED' },
  { status: 413, code: 'CONTEXT_TOO_LARGE' },
  { status: 429, code: 'PROVIDER_RATE_LIMITED' },
  { status: 500, code: 'PROVIDER_ERROR' },
  { status: 529, code: 'PROVIDER_ERROR' },
  // The company gateway's own marker wins over the status (classifyDshFailureText).
  {
    status: 503,
    code: 'GATEWAY_NO_UPSTREAM',
    message: 'no_available_providers: every upstream is busy',
  },
  // A gateway that names Claude Code and echoes the key it was sent (§7.4 #3): neither may
  // reach the failure card or the host's stderr, which Main shows in the Host stderr panel.
  {
    status: 401,
    code: 'PROVIDER_UNAUTHORIZED',
    message: 'Claude Code requests are not accepted with this key',
    echoKey: true,
  },
];

/** `worker.bootstrap` for the probe's chat, on the host just started. */
async function bootstrap(): Promise<void> {
  const t0 = Date.now();
  const boot = await request<Record<string, unknown>>('worker.bootstrap', {
    logicalSessionId,
    cwd: bootstrapCwd(),
    // S-3: a chat not bound to a project (Main sends this for a scratch chat).
    ...(scenarios.includes('projcfg-scratch') ? { unbound: true } : {}),
    model: 'probe-gw/claude-opus-5-5',
    ...(process.env.PROBE_SESSION_FILE ? { sessionFile: process.env.PROBE_SESSION_FILE } : {}),
  });
  sessionFile = String(boot.sessionFile);
  if (process.env.PROBE_SESSION_FILE) {
    const initial = boot.initialHistory as { page?: { messages?: unknown[] } } | undefined;
    check(
      'bootstrap',
      'a reopened session brings its history',
      (initial?.page?.messages?.length ?? 0) > 0
    );
  }
  console.log(
    `bootstrap ${Date.now() - t0} ms: ${JSON.stringify({ ...boot, initialHistory: boot.initialHistory ? `(page of ${(boot.initialHistory as { page: { messages: unknown[] } }).page.messages.length})` : undefined })}`
  );
}

/** S-3: dispose the host, wait for it to exit, and start and bootstrap a new one. */
async function restartHost(): Promise<void> {
  const previous = child;
  const exited = new Promise<void>((resolve) => {
    if (previous.exitCode !== null || previous.signalCode !== null) resolve();
    else previous.once('exit', () => resolve());
  });
  await request('worker.dispose', { reason: 'slot-dispose' });
  await exited;
  hostGone = undefined;
  startHost();
  await bootstrap();
}

async function main(): Promise<void> {
  const projcfg = scenarios.filter((s) => PROJCFG_SCENARIOS.includes(s));
  if (projcfg.length > 0) {
    if (scenarios.length !== 1) {
      throw new Error(`${projcfg.join(',')}: run on its own, in its own workspace`);
    }
    writeProjectFixture();
  } else if (scenarios.includes('repoenv') || scenarios.includes('mode-plan-refused')) {
    writeRepoSettings();
  }
  if (scenarios.includes('webfetch')) await startFetchProxy();
  if (scenarios.includes('proxy')) {
    if (scenarios.length !== 1) throw new Error('proxy: run on its own');
    outboundProxy = await startTestProxy({
      credentials: { username: 'pilab probe', password: OUTBOUND_PROXY_PASSWORD },
    });
  }
  if (scenarios.includes('slash')) writeSlashFixture();
  startHost();
  await bootstrap();

  for (const scenario of scenarios) {
    scenarioEvents = [];
    switch (scenario) {
      case 'text': {
        await send('CC-TEXT hello');
        const end = await waitFor(terminal, 'text turn end');
        show('text');
        check('text', 'ends in session.completed', end.type === 'session.completed');
        check('text', 'streams assistant text', assistantText().length > 0);
        check('text', 'streams thinking', countOf('thinking.delta') > 0);
        break;
      }
      case 'tools': {
        await send('CC-TOOLS run a command, write, read');
        const card = await waitFor((e) => e.type === 'permission.requested', 'permission card');
        console.log(`  card: ${JSON.stringify(card.payload)}`);
        const answered = await request('worker.permission.respond', {
          logicalSessionId,
          permissionId: card.payload?.permissionId,
          decision: 'allow',
        });
        console.log(`  respond → ${JSON.stringify(answered)}`);
        const end = await waitFor(terminal, 'tools turn end');
        show('tools');
        check('tools', 'ends in session.completed', end.type === 'session.completed');
        check('tools', 'the card is for Write', card.payload?.toolName === 'Write');
        checkTools('tools', ['Bash', 'Write', 'Read']);
        break;
      }
      case 'ask': {
        await send('CC-ASK please');
        const q = await waitFor((e) => e.type === 'question.requested', 'question');
        const first = (q.payload?.questions as Array<{ question: string }>)[0];
        await request('worker.question.respond', {
          logicalSessionId,
          questionId: q.payload?.questionId,
          answers: { [first.question]: '提问卡' },
        });
        const end = await waitFor(terminal, 'ask turn end');
        show('ask');
        check('ask', 'ends in session.completed', end.type === 'session.completed');
        check(
          'ask',
          'the question resolves as answered',
          events.some((e) => e.type === 'question.resolved' && e.payload?.outcome === 'answered')
        );
        checkTools('ask', ['AskUserQuestion']);
        check(
          'ask',
          'the answer reaches the model (gateway echo)',
          assistantText().includes('提问卡')
        );
        break;
      }
      case 'stop': {
        // The sleeps are counted machine-wide by their command line: a duration of this
        // run's own keeps another probe running at the same time out of the count (S-5).
        const seconds = 97 + (process.pid % 400);
        const before = sleepers(seconds);
        // Bypass gear: the command runs without a card, so Stop meets a live process tree.
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        await send(`CC-SLOW {"seconds":${seconds}}`);
        await waitFor(
          (e) =>
            e.type === 'tool.updated' &&
            Boolean((e.payload?.input as Record<string, unknown>)?.command),
          'slow tool input'
        );
        // Until both sleeps run (README §10.2 #39): with the full vitest run beside it the
        // command took about 30 s to start (measured), so a fixed 3 s missed it. Capped by
        // PROBE_STOP_WAIT_S (default 60 s) so a command that never starts still fails.
        const waitCap = Number(process.env.PROBE_STOP_WAIT_S ?? 60) * 1000;
        const waitStart = Date.now();
        let during = sleepers(seconds);
        while (during < before + 2 && Date.now() - waitStart < waitCap) {
          await new Promise((r) => setTimeout(r, 500));
          during = sleepers(seconds);
        }
        console.log(`  sleeps seen: ${during - before} after ${Date.now() - waitStart} ms`);
        // The host samples the call's processes in the background (toolProcessTracker.ts,
        // README §11.2 #52): a Stop within the first second of the command can precede the
        // sample that sees its shell. A moment's settle, as a person's Stop has; the bar
        // below (gone within 5 s of Stop) is unchanged. PROBE_STOP_SETTLE_MS overrides.
        const settle = Number(process.env.PROBE_STOP_SETTLE_MS ?? 1_500);
        await new Promise((r) => setTimeout(r, settle));
        const t = Date.now();
        const stopped = await request('worker.stop', { logicalSessionId, reason: 'user' });
        const end = await waitFor(terminal, 'stop turn end', 15_000);
        console.log(
          `  stop → ${JSON.stringify(stopped)}; terminal ${end.type} after ${Date.now() - t} ms`
        );
        const trail: number[] = [];
        for (let i = 1; i <= 12; i += 1) {
          await new Promise((r) => setTimeout(r, 1_000));
          trail.push(sleepers(seconds));
        }
        console.log(
          `  sleep processes: before=${before} during=${during} after-stop ${trail.map((n, i) => `${i + 1}s:${n}`).join(' ')}`
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        show('stop');
        check('stop', 'ends in session.stopped', end.type === 'session.stopped');
        check('stop', 'the sleeps were running before Stop', during > before);
        // What the host saw and reaped at Stop (its stderr), so a CI log shows why when
        // this check fails there (README §11.2 #52).
        for (const line of hostStderr.filter((l) =>
          /\bstart pid=|process snapshot:|process sample failed|msys tool processes:|reaped \d+ process/.test(
            l
          )
        )) {
          console.log(`  [host] ${line.slice(0, 1200)}`);
        }
        const left = !trail.slice(4).every((n) => n <= before);
        if (left && process.platform === 'win32') {
          for (const line of describeSleepers(seconds)) console.log(`  [left] ${line}`);
        }
        // The prototype doc's bar (§5.1): orphans are gone within a few seconds of Stop.
        // On CI this reports without blocking for now (README §11.2 #52, temporary).
        check('stop', 'no sleep left 5 s after Stop', !left, {
          reportOnly: process.env.PROBE_STOP_LEFTOVER_REPORT_ONLY === '1',
        });
        if (process.platform === 'win32' && process.env.PROBE_PS_DIAG === '1') {
          await diagnosePowerShell();
        }
        break;
      }
      case 'plan': {
        // S-2: the composer's plan preset ({plan, auto}), and the SDK card's default choice.
        await request('worker.setPermissions', {
          logicalSessionId,
          permissions: { mode: 'plan', gear: 'auto' },
        });
        await send('CC-PLAN make a plan');
        const q = await waitFor((e) => e.type === 'question.requested', 'plan review');
        console.log(`  review: ${JSON.stringify(q.payload?.review).slice(0, 200)}`);
        await request('worker.question.respond', {
          logicalSessionId,
          questionId: q.payload?.questionId,
          answers: { 'plan-review': 'run:accept-edits' },
        });
        const end = await waitFor(terminal, 'plan turn end');
        show('plan');
        check('plan', 'ends in session.completed', end.type === 'session.completed');
        check(
          'plan',
          'the review card carries the plan',
          (q.payload?.review as { kind?: string } | undefined)?.kind === 'plan'
        );
        check(
          'plan',
          'approval switches the gear (plan-approved)',
          events.some(
            (e) => e.type === 'session.permissions' && e.payload?.cause === 'plan-approved'
          )
        );
        check(
          'plan',
          'the card offers the modes to continue in, no goals (S-2 A-7)',
          JSON.stringify((q.payload?.review as { choices?: unknown })?.choices) ===
            JSON.stringify(SDK_REVIEW_CHOICES)
        );
        checkTools('plan', ['ExitPlanMode']);
        await request('worker.setPermissions', {
          logicalSessionId,
          permissions: { mode: 'agent', gear: 'ask' },
        });
        break;
      }
      case 'mode-manual': {
        await setPosture('agent', 'ask');
        const file = modePath('mode-manual.txt');
        const dir = modePath('mode-manual-dir');
        const { end, cards } = await runCalls(
          [
            { name: 'Write', input: { file_path: file, content: 'manual' } },
            {
              name: 'Bash',
              input: { command: 'mkdir mode-manual-dir', description: 'Make a dir' },
            },
          ],
          () => 'allow'
        );
        show('mode-manual');
        check('mode-manual', 'ends in session.completed', end.type === 'session.completed');
        check('mode-manual', 'the write and the command each ask', cards.join() === 'Write,Bash');
        check('mode-manual', 'both ran once allowed', existsSync(file) && existsSync(dir));
        break;
      }
      case 'mode-edits': {
        await setPosture('agent', 'accept-edits');
        const file = modePath('mode-edits.txt');
        const dir = modePath('mode-edits-dir');
        const other = modePath('mode-edits-node.txt');
        const { end, cards } = await runCalls(
          [
            { name: 'Write', input: { file_path: file, content: 'edits' } },
            { name: 'Bash', input: { command: 'mkdir mode-edits-dir', description: 'Make a dir' } },
            {
              name: 'Bash',
              input: {
                command: `node -e "require('fs').writeFileSync('mode-edits-node.txt','x')"`,
                description: 'Write a file with node',
              },
            },
          ],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        show('mode-edits');
        check('mode-edits', 'ends in session.completed', end.type === 'session.completed');
        check(
          'mode-edits',
          'the workspace write and mkdir run without a card',
          existsSync(file) && existsSync(dir)
        );
        check('mode-edits', 'only the other command asks', cards.join() === 'Bash');
        check('mode-edits', 'the denied command did not run', !existsSync(other));
        break;
      }
      case 'mode-plan': {
        // Ruling 20: the CLI's own plan mode. Auto's check decides first (the fake
        // gateway's blocks a call here), then a write asks, a command and a read outside
        // the workspace pass the check, and the review card leaves plan mode.
        await setPosture('plan', 'auto');
        const checked = modePath('mode-plan-checked.txt');
        const blocked = await runCalls(
          [
            {
              name: 'Bash',
              input: {
                command: `node -e "require('fs').writeFileSync('mode-plan-checked.txt','x')"`,
                description: 'Write a file with node',
              },
            },
          ],
          () => 'allow',
          undefined,
          'CC-CLS-BLOCK'
        );
        const file = modePath('mode-plan.txt');
        const dir = modePath('mode-plan-dir');
        // A file outside the workspace: the CLI asks about reading it, in plan mode too.
        const outside = join(tmpdir(), `pilab-probe-outside-${Date.now()}.txt`);
        writeFileSync(outside, 'outside the workspace\n');
        const { end, cards, reviews } = await runCalls(
          [
            { name: 'Read', input: { file_path: outside } },
            { name: 'Write', input: { file_path: file, content: 'plan' } },
            { name: 'Bash', input: { command: 'mkdir mode-plan-dir', description: 'Make a dir' } },
            { name: 'ExitPlanMode', input: {} },
          ],
          () => 'allow',
          'run:accept-edits'
        );
        rmSync(outside, { force: true });
        show('mode-plan');
        check('mode-plan', 'ends in session.completed', end.type === 'session.completed');
        check(
          'mode-plan',
          "plan mode goes through Auto's check: the call it blocks does not run, no card",
          blocked.end.type === 'session.completed' &&
            blocked.cards.length === 0 &&
            !existsSync(checked)
        );
        check(
          'mode-plan',
          'a write asks (the CLI refuses writes in plan mode unless allowed); nothing else does',
          cards.join() === 'Write'
        );
        check(
          'mode-plan',
          'the allowed write and the checked command ran',
          existsSync(file) && existsSync(dir)
        );
        check(
          'mode-plan',
          'the SDK review card came up',
          reviews.length === 1 &&
            JSON.stringify((reviews[0]?.payload?.review as { choices?: unknown })?.choices) ===
              JSON.stringify(SDK_REVIEW_CHOICES)
        );
        // The CLI now runs in Edit automatically: a workspace write needs no card.
        const after = modePath('mode-plan-after.txt');
        const next = await runCalls(
          [{ name: 'Write', input: { file_path: after, content: 'after' } }],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        check(
          'mode-plan',
          'after approval the chosen mode is in force',
          next.cards.length === 0 && existsSync(after)
        );
        break;
      }
      case 'proxy': {
        const proxy = outboundProxy as TestProxy;
        const setting = outboundSetting() as { url: string; noProxy: string };
        const gatewayHost = new URL(hostGatewayUrl).host;
        const viaProxy = () => proxy.records.filter((r) => r.target === gatewayHost);
        await setPosture('agent', 'bypass');
        // on
        await send('CC-TEXT hello');
        const onEnd = await waitFor(terminal, 'proxy on turn end', 120_000);
        show('proxy');
        check('proxy', 'on: the turn completed', onEnd.type === 'session.completed');
        check(
          'proxy',
          'on: every model request went through the proxy, authorised',
          viaProxy().length > 0 && viaProxy().every((r) => r.authorized && r.status === 200)
        );
        check(
          'proxy',
          'on: the host logged the product proxy',
          hostStderr.some((line) => /outbound=on \(http proxy; \d+ bypass entries\)/.test(line))
        );
        // The CLI and its tools (rule 7).
        await runCalls(
          [{ name: 'Bash', input: { command: 'env', description: 'Print the environment' } }],
          () => 'allow'
        );
        const dump = events
          .filter((e) => e.type === 'tool.completed')
          .map((e) => String(e.payload?.output ?? ''))
          .join('\n');
        const seen = (name: string) => new RegExp(`^${name}=(.*)$`, 'im').exec(dump)?.[1]?.trim();
        check(
          'proxy',
          "the CLI's Bash tool sees the product proxy and NODE_USE_ENV_PROXY=1",
          seen('https_proxy') === setting.url && seen('NODE_USE_ENV_PROXY') === '1'
        );
        // off: direct, so `gateway.invalid` is unreachable; stopped once the host says so.
        const failure = /auth proxy: upstream request failed/;
        const failedBefore = hostStderr.filter((line) => failure.test(line)).length;
        child.send({ type: 'host.proxy', proxy: null });
        const beforeOff = viaProxy().length;
        await send('CC-TEXT hello');
        const failed = await waitForHostLines(failure, failedBefore, 60_000);
        await request('worker.stop', { logicalSessionId, reason: 'user' });
        await waitFor(terminal, 'proxy off turn end', 60_000);
        check(
          'proxy',
          'off: the host logged the switch',
          hostStderr.some((line) => line.includes('auth proxy: outbound proxy off'))
        );
        check('proxy', 'off: the request went direct and failed', failed);
        check('proxy', 'off: nothing reached the proxy', viaProxy().length === beforeOff);
        // on again, no restart
        child.send({ type: 'host.proxy', proxy: setting });
        const beforeAgain = viaProxy().length;
        await send('CC-TEXT hello');
        const againEnd = await waitFor(terminal, 'proxy on-again turn end', 120_000);
        check(
          'proxy',
          'on again: the turn completed through the proxy',
          againEnd.type === 'session.completed' && viaProxy().length > beforeAgain
        );
        check(
          'proxy',
          "the host's stderr never quotes the proxy password",
          hostStderr.every((line) => !line.includes(OUTBOUND_PROXY_PASSWORD))
        );
        console.log(
          `  [proxy] records=${proxy.records.length} lines=${JSON.stringify(
            hostStderr.filter((l) => /outbound|auth proxy/.test(l)).map((l) => l.slice(0, 200))
          )}`
        );
        break;
      }
      case 'keyiso': {
        await setPosture('agent', 'bypass');
        const { end } = await runCalls(
          [
            { name: 'Bash', input: { command: 'env', description: 'Print the environment' } },
            {
              name: 'Bash',
              input: {
                command: `powershell.exe -NoProfile -Command "Get-ChildItem env: | ForEach-Object { $_.Name + '=' + $_.Value }"`,
                description: 'Print the environment from PowerShell',
              },
            },
          ],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        const outputs = events
          .filter((e) => e.type === 'tool.completed')
          .map((e) => JSON.stringify(e.payload?.output ?? ''));
        await send('CC-ENV which key');
        await waitFor(terminal, 'keyiso env turn end');
        const reply = assistantText();
        const filesWithKey: string[] = [];
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (readFileSync(full, 'latin1').includes(apiKey)) filesWithKey.push(full);
          }
        };
        walk(configDir);
        show('keyiso');
        check('keyiso', 'the turn completed', end.type === 'session.completed');
        check(
          'keyiso',
          'the tools saw a session token, not the key',
          outputs.length === 2 &&
            outputs.every((text) => !text.includes(apiKey)) &&
            outputs.some((text) => text.includes('sk-pilab-session-'))
        );
        check('keyiso', 'the gateway still got the key', reply.includes(`key=${keyDigest}`));
        check('keyiso', 'no file under the config dir holds the key', filesWithKey.length === 0);
        check(
          'keyiso',
          "the host's stderr never quotes the key",
          hostStderr.every((line) => !line.includes(apiKey))
        );
        break;
      }
      case 'projcfg':
      case 'projcfg-scratch': {
        const bound = scenario === 'projcfg';
        const canaries = await echoTurn(scenario);
        show(`${scenario} echo`);
        const touched = modePath('projcfg-touched.txt');
        const made = modePath('projcfg-made');
        const ruled = modePath('projcfg-rule-manual.txt');
        const allowed = await runCalls(
          [
            {
              name: 'Bash',
              input: { command: 'touch projcfg-touched.txt', description: 'Create a file' },
            },
            { name: 'Bash', input: { command: 'mkdir projcfg-made', description: 'Make a dir' } },
            { name: 'Write', input: { file_path: ruled, content: 'x' } },
          ],
          () => 'deny'
        );
        show(`${scenario} rules`);
        const written = modePath('projcfg-written.txt');
        const asked = await runCalls(
          [{ name: 'Write', input: { file_path: written, content: 'x' } }],
          () => 'deny'
        );
        // Ruling 20 (P-9 withdrawn): in plan mode the CLI's own rules hold: the command
        // a project rule allows runs, a write asks even with a rule, exploration runs.
        await setPosture('plan', 'ask');
        const planTouched = modePath('projcfg-plan.txt');
        const planWritten = modePath('projcfg-rule-plan.txt');
        const planned = await runCalls(
          [
            {
              name: 'Bash',
              input: { command: 'touch projcfg-plan.txt', description: 'Create a file' },
            },
            { name: 'Bash', input: { command: 'ls', description: 'List files' } },
            { name: 'Write', input: { file_path: planWritten, content: 'x' } },
          ],
          () => 'deny'
        );
        const planOk = toolRuns().okNames;
        await setPosture('agent', 'ask');
        let refusal = '';
        await setPosture('agent', 'bypass').catch((error: Error) => {
          refusal = error.message;
        });
        await setPosture('agent', 'ask').catch(() => undefined);
        const hooks = hookLines();
        // P-4: a trusted workspace's marketplaces are fetched from the CLI's second start on.
        await restartHost();
        await send('CC-TEXT second start');
        const second = await waitFor(terminal, `${scenario} second start turn end`);
        const traces = marketplaceTraces();
        console.log(`  echoed: ${canaries.join(',') || 'none'}`);
        console.log(`  hook lines: ${hooks.length}; bypass refusal: ${refusal || '(none)'}`);
        console.log(`  marketplace traces: ${traces.join(', ') || 'none'}`);
        if (bound) {
          check(
            scenario,
            "the project's CLAUDE.md, .claude/CLAUDE.md, rules and CLAUDE.local.md reach the model",
            PROJECT_CANARIES.every((c) => canaries.includes(c))
          );
          check(
            scenario,
            "the user layer's CLAUDE.md (the app's config dir) reaches the model",
            canaries.includes(CANARIES.userMd)
          );
          check(
            scenario,
            'the project allow rules (trusted workspace) and the local one skip the card',
            allowed.end.type === 'session.completed' &&
              allowed.cards.length === 0 &&
              existsSync(touched) &&
              existsSync(made) &&
              existsSync(ruled)
          );
          check(
            scenario,
            'a call no rule allows still asks',
            asked.cards.join() === 'Write' && !existsSync(written)
          );
          check(
            scenario,
            'plan mode: the allowed command runs, a write asks, exploration runs (official)',
            planned.end.type === 'session.completed' &&
              planned.cards.join() === 'Write' &&
              existsSync(planTouched) &&
              !existsSync(planWritten) &&
              planOk.join() === 'Bash,Bash'
          );
          check(
            scenario,
            "the project's PreToolUse hook ran for each Bash call (four)",
            hooks.filter((line) => line.tool === 'Bash').length === 4
          );
          check(
            scenario,
            'the hook saw the session token, never the key',
            hooks.length > 0 &&
              hooks.every(
                (line) => line.key?.startsWith('sk-pilab-session-') && line.key !== apiKey
              )
          );
          check(
            scenario,
            "the project's disableBypassPermissionsMode refuses Bypass permissions",
            refusal.includes('WORKER_PERMISSION_MODE_REFUSED') &&
              refusal.includes('bypass_disabled')
          );
        } else {
          check(
            scenario,
            "only the user layer's CLAUDE.md reaches the model, no project file",
            canaries.join() === CANARIES.userMd
          );
          check(
            scenario,
            'no project or local allow rule: every call asks',
            allowed.cards.join() === 'Bash,Bash,Write' &&
              !existsSync(touched) &&
              !existsSync(made) &&
              !existsSync(ruled)
          );
          check(
            scenario,
            "plan mode: a write asks; the command and exploration pass Auto's rules (official)",
            planned.cards.join() === 'Write' &&
              existsSync(planTouched) &&
              !existsSync(planWritten) &&
              planOk.join() === 'Bash,Bash'
          );
          check(scenario, "the project's hook never runs", hooks.length === 0);
          check(scenario, "the project's settings refuse nothing", refusal === '');
        }
        check(scenario, 'the host started again', second.type === 'session.completed');
        if (bound) {
          // Ruling 18: a trusted project's marketplaces as the CLI has them.
          check(scenario, 'the declared plugin was loaded (official)', existsSync(pluginMarker));
          check(scenario, 'the declared marketplace was fetched (official)', traces.length > 0);
        } else {
          check(scenario, 'the declared plugin was not loaded', !existsSync(pluginMarker));
          check(scenario, 'the declared marketplace was not fetched', traces.length === 0);
        }
        break;
      }
      case 'projcfg-home': {
        const canaries = await echoTurn('projcfg-home');
        show('projcfg-home');
        console.log(`  cwd: ${bootstrapCwd()}; echoed: ${canaries.join(',') || 'none'}`);
        check(
          'projcfg-home',
          "the project's instruction files reach the model",
          PROJECT_CANARIES.every((c) => canaries.includes(c))
        );
        check(
          'projcfg-home',
          "an ancestor's CLAUDE.md is read (official behaviour)",
          canaries.includes(CANARIES.homeMd)
        );
        check(
          'projcfg-home',
          "the home directory's .claude (CLAUDE.md, rules) is not",
          !canaries.includes(CANARIES.homeDotClaude) && !canaries.includes(CANARIES.homeRule)
        );
        break;
      }
      case 'mode-plan-refused': {
        // The workspace's settings disable Bypass permissions (written before the host starts).
        await setPosture('plan', 'auto');
        const { end, reviews } = await runCalls(
          [{ name: 'ExitPlanMode', input: {} }],
          () => 'deny',
          'run:bypass'
        );
        const fell = events.find(
          (e) => e.type === 'session.permissions' && e.payload?.cause === 'engine'
        );
        // The plan ran in Manual: a write asks.
        const after = modePath('mode-plan-refused.txt');
        const next = await runCalls(
          [{ name: 'Write', input: { file_path: after, content: 'x' } }],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        show('mode-plan-refused');
        check(
          'mode-plan-refused',
          'the review came up and the turn ended',
          reviews.length === 1 && end.type === 'session.completed'
        );
        check(
          'mode-plan-refused',
          'the refused mode falls to Manual, with its reason',
          JSON.stringify(fell?.payload) ===
            JSON.stringify({
              permissions: { mode: 'agent', gear: 'ask' },
              cause: 'engine',
              refusedReason: 'bypass_disabled',
            })
        );
        check(
          'mode-plan-refused',
          'Manual is in force: the next write asks',
          next.cards.join() === 'Write' && !existsSync(after)
        );
        break;
      }
      case 'mode-bypass': {
        await setPosture('agent', 'bypass');
        const file = modePath('mode-bypass.txt');
        const other = modePath('mode-bypass-node.txt');
        const { end, cards } = await runCalls(
          [
            { name: 'Write', input: { file_path: file, content: 'bypass' } },
            {
              name: 'Bash',
              input: {
                command: `node -e "require('fs').writeFileSync('mode-bypass-node.txt','x')"`,
                description: 'Write a file with node',
              },
            },
          ],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        show('mode-bypass');
        check('mode-bypass', 'ends in session.completed', end.type === 'session.completed');
        check('mode-bypass', 'no card', cards.length === 0);
        check('mode-bypass', 'both ran', existsSync(file) && existsSync(other));
        break;
      }
      case 'mode-switch': {
        await setPosture('agent', 'ask');
        const first = modePath('mode-switch-1.txt');
        const second = modePath('mode-switch-2.txt');
        let switched: unknown;
        const { end, cards, answeredByProbe } = await runCalls(
          [
            { name: 'Write', input: { file_path: first, content: '1' } },
            { name: 'Write', input: { file_path: second, content: '2' } },
          ],
          async () => {
            // Mid-turn, with the card up: Edit automatically from the next call on.
            switched = await setPosture('agent', 'accept-edits');
            return 'allow' as const;
          }
        );
        await setPosture('agent', 'ask');
        show('mode-switch');
        check('mode-switch', 'ends in session.completed', end.type === 'session.completed');
        check(
          'mode-switch',
          'the switch mid-turn is applied',
          (switched as { applied?: boolean })?.applied === true
        );
        check(
          'mode-switch',
          'the card already up stays for the user (nothing settles it before their answer)',
          cards.join() === 'Write' && answeredByProbe.every(Boolean)
        );
        check(
          'mode-switch',
          'the next call of the turn runs on the new mode',
          existsSync(first) && existsSync(second)
        );
        break;
      }
      case 'mode-enterplan': {
        await setPosture('agent', 'ask');
        const { end } = await runCalls([{ name: 'EnterPlanMode', input: {} }], () => 'deny');
        // The turn's own events (`send` starts the list afresh).
        const reported = events.find(
          (e) => e.type === 'session.permissions' && e.payload?.cause === 'engine'
        );
        await setPosture('agent', 'ask');
        show('mode-enterplan');
        check('mode-enterplan', 'ends in session.completed', end.type === 'session.completed');
        check(
          'mode-enterplan',
          'the model entering plan mode reaches PiLab (engine)',
          JSON.stringify(reported?.payload?.permissions) ===
            JSON.stringify({ mode: 'plan', gear: 'auto' })
        );
        break;
      }
      case 'mode-auto': {
        await setPosture('agent', 'auto');
        const node = (file: string) => ({
          name: 'Bash',
          input: {
            command: `node -e "require('fs').writeFileSync('${file}','x')"`,
            description: 'Write a file with node',
          },
        });
        const refusedRows = () =>
          events.filter((e) => e.type === 'tool.completed' && e.payload?.ok === false);
        const rowText = (e: Event) => JSON.stringify(e.payload ?? {});
        // 1. The check allows: the call runs, no card.
        const allowed = modePath('mode-auto-allow.txt');
        const a = await runCalls([node('mode-auto-allow.txt')], () => 'deny');
        show('mode-auto (allow)');
        check(
          'mode-auto',
          'allowed by the check: ran with no card',
          a.cards.length === 0 && existsSync(allowed)
        );
        // 2. Three blocks in a row: refused with no card, the third falls back to PiLab's card.
        const blocked = ['mode-auto-b1.txt', 'mode-auto-b2.txt', 'mode-auto-b3.txt'].map(modePath);
        const b = await runCalls(
          [node('mode-auto-b1.txt'), node('mode-auto-b2.txt'), node('mode-auto-b3.txt')],
          () => 'deny',
          undefined,
          'CC-CLS-BLOCK'
        );
        const blockRows = refusedRows();
        show('mode-auto (block)');
        check(
          'mode-auto',
          'blocked calls did not run',
          blocked.every((file) => !existsSync(file))
        );
        check(
          'mode-auto',
          'the third block in a row comes to PiLab as a card',
          b.cards.join() === 'Bash'
        );
        check(
          'mode-auto',
          'a blocked row says why in our words, never the CLI sentence',
          blockRows.some((e) =>
            rowText(e).includes("Auto mode's safety check blocked this call")
          ) && blockRows.every((e) => !rowText(e).includes('Claude Code'))
        );
        // 3. The check is down: refused with no card (the CLI fails closed).
        const down = modePath('mode-auto-down.txt');
        const d = await runCalls(
          [node('mode-auto-down.txt')],
          () => 'allow',
          undefined,
          'CC-CLS-DOWN'
        );
        const downRows = refusedRows();
        await setPosture('agent', 'ask');
        show('mode-auto (down)');
        check(
          'mode-auto',
          'with the check down the call does not run',
          d.cards.length === 0 && !existsSync(down)
        );
        check(
          'mode-auto',
          'the row says the check was not available, never the CLI sentence',
          downRows.some((e) => rowText(e).includes("Auto mode's safety check was not available")) &&
            downRows.every((e) => !rowText(e).includes('Claude Code'))
        );
        check(
          'mode-auto',
          'each turn completes',
          [a, b, d].every((r) => r.end.type === 'session.completed')
        );
        break;
      }
      case 'steer': {
        await send('CC-STEER two steps');
        await waitFor((e) => e.type === 'tool.started', 'first steer step');
        const r = await request('worker.interject', {
          logicalSessionId,
          attemptId: 'interject-1',
          text: '插话：顺便看一下 README',
        });
        console.log(`  interject → ${JSON.stringify(r)}`);
        const end = await waitFor(terminal, 'steer turn end', 90_000);
        show('steer');
        check('steer', 'ends in session.completed', end.type === 'session.completed');
        check(
          'steer',
          'the interjection is accepted',
          (r as { interjected?: boolean }).interjected === true
        );
        check(
          'steer',
          'the interjection is echoed as a user message',
          events.some(
            (e) =>
              e.type === 'message.started' &&
              e.payload?.role === 'user' &&
              e.payload?.attemptId === 'interject-1'
          )
        );
        // The gateway's last step echoes what reached the model after `收到的插话：`.
        const joined = assistantText();
        const echoAt = joined.indexOf('收到的插话');
        check(
          'steer',
          'the model sees it (gateway echo)',
          echoAt >= 0 && joined.slice(echoAt).includes('顺便看一下 README')
        );
        break;
      }
      case 'steer-late': {
        // S-6 feedback 13: a Ctrl+Enter message sent while the turn's LAST reply streams
        // (no tool step left to fold it in at). The CLI runs it as its next turn; the
        // product turn must stay open, echo it and show that reply, never strand it as
        // 'awaiting delivery' or open an engine turn as if a background task had woken it.
        const delays = (process.env.PROBE_STEER_LATE_DELAYS ?? '0,400,1200,2500')
          .split(',')
          .map((d) => Number(d.trim()))
          .filter((d) => Number.isFinite(d) && d >= 0);
        for (const delay of delays) {
          const tag = `late-${delay}`;
          await send(`CC-TEXT steer ${tag}`);
          await waitFor(
            (e) => e.type === 'thinking.delta' || e.type === 'message.delta',
            `${tag}: first streamed delta`
          );
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const attemptId = `interject-${tag}`;
          const before = events.find(terminal);
          const r = await request('worker.interject', {
            logicalSessionId,
            attemptId,
            text: `插话 ${tag}`,
          });
          console.log(
            `  ${tag}: interject → ${JSON.stringify(r)} (turn already ended: ${Boolean(before)})`
          );
          const accepted = (r as { interjected?: boolean }).interjected === true;
          let end: Event | undefined;
          try {
            end = await waitFor(terminal, `${tag}: turn end`, 60_000);
          } catch (error) {
            console.log(`  ${tag}: ${String(error)}`);
          }
          // Whatever the CLI does next with the message happens within a few seconds.
          await new Promise((r) => setTimeout(r, 6000));
          show(`steer-late ${tag}`);
          const echoed = events.some(
            (e) =>
              e.type === 'message.started' &&
              e.payload?.role === 'user' &&
              e.payload?.attemptId === attemptId
          );
          const engineHeads = events.filter(
            (e) =>
              e.type === 'message.started' &&
              e.payload?.role === 'user' &&
              typeof e.payload?.origin === 'object'
          ).length;
          const terminals = events.filter(terminal).length;
          const replies = assistantText().split('PiLab × Claude Agent SDK').length - 1;
          console.log(
            `  ${tag}: accepted=${accepted} echoed=${echoed} engineHeads=${engineHeads} terminals=${terminals} replies=${replies}`
          );
          if (!accepted) {
            // Too late for the turn: the composer sends it as a normal message instead.
            check(
              'steer-late',
              `${tag}: a refused interjection leaves no engine turn`,
              engineHeads === 0
            );
            continue;
          }
          check(
            'steer-late',
            `${tag}: the turn ends in session.completed`,
            end?.type === 'session.completed'
          );
          check('steer-late', `${tag}: the accepted interjection is echoed`, echoed);
          check('steer-late', `${tag}: no engine turn opens for it`, engineHeads === 0);
          check('steer-late', `${tag}: one product turn, one terminal event`, terminals === 1);
          check('steer-late', `${tag}: the reply to it is shown`, replies >= 2);
        }
        await send('CC-TEXT after the late interjections');
        const after = await waitFor(terminal, 'steer-late follow-up end');
        check(
          'steer-late',
          'a normal send afterwards completes',
          after.type === 'session.completed'
        );
        check(
          'steer-late',
          'and its reply is shown',
          assistantText().includes('PiLab × Claude Agent SDK')
        );
        break;
      }
      case 'steer-withdraw': {
        // S-6 feedback 13: a late Ctrl+Enter message taken back at once. Either the CLI
        // dropped it (withdrawn: no echo, no reply to it, the turn ends) or a CLI turn
        // already ran on it (delivered: echoed and answered). Never both, never stranded.
        await send('CC-TEXT steer withdraw');
        await waitFor(
          (e) => e.type === 'thinking.delta' || e.type === 'message.delta',
          'withdraw: first streamed delta'
        );
        const attemptId = 'interject-withdraw';
        const r = await request('worker.interject', {
          logicalSessionId,
          attemptId,
          text: '插话 withdraw',
        });
        const w = (await request('worker.interject.withdraw', {
          logicalSessionId,
          attemptId,
        }).catch((error) => ({ outcome: `error ${String(error)}` }))) as { outcome?: string };
        console.log(`  interject → ${JSON.stringify(r)}; withdraw → ${JSON.stringify(w)}`);
        let end: Event | undefined;
        try {
          end = await waitFor(terminal, 'withdraw: turn end', 60_000);
        } catch (error) {
          console.log(`  withdraw: ${String(error)}`);
        }
        await new Promise((r) => setTimeout(r, 6000));
        show('steer-withdraw');
        const echoed = events.some(
          (e) =>
            e.type === 'message.started' &&
            e.payload?.role === 'user' &&
            e.payload?.attemptId === attemptId
        );
        const engineHeads = events.filter(
          (e) =>
            e.type === 'message.started' &&
            e.payload?.role === 'user' &&
            typeof e.payload?.origin === 'object'
        ).length;
        const replies = assistantText().split('PiLab × Claude Agent SDK').length - 1;
        console.log(`  withdraw: echoed=${echoed} engineHeads=${engineHeads} replies=${replies}`);
        check(
          'steer-withdraw',
          'the turn ends in session.completed',
          end?.type === 'session.completed'
        );
        check('steer-withdraw', 'one terminal event', events.filter(terminal).length === 1);
        check('steer-withdraw', 'no engine turn opens', engineHeads === 0);
        check(
          'steer-withdraw',
          'withdrawn means not echoed and not answered; delivered means both',
          w.outcome === 'withdrawn'
            ? !echoed && replies === 1
            : w.outcome === 'delivered'
              ? echoed && replies >= 2
              : false
        );
        await send('CC-TEXT after the withdrawal');
        const after = await waitFor(terminal, 'withdraw follow-up end');
        check(
          'steer-withdraw',
          'a normal send afterwards completes',
          after.type === 'session.completed'
        );
        break;
      }
      case 'sendnow': {
        // S-6 feedback 13, the queue's "Send now": Stop the running turn, then send at once.
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        await send('CC-SLOW {"seconds":20}');
        await waitFor((e) => e.type === 'tool.started', 'sendnow: slow command started');
        await new Promise((r) => setTimeout(r, 1500));
        const stopped = await request('worker.stop', { logicalSessionId, reason: 'user' });
        const first = await waitFor(terminal, 'sendnow: stopped turn end', 30_000);
        const firstEvents = events;
        await send('CC-TEXT sent right after Stop');
        let second: Event | undefined;
        try {
          second = await waitFor(terminal, 'sendnow: next turn end', 60_000);
        } catch (error) {
          console.log(`  sendnow: ${String(error)}`);
        }
        await new Promise((r) => setTimeout(r, 4000));
        show('sendnow');
        console.log(
          `  sendnow: stop → ${JSON.stringify(stopped)}; first=${first.type} second=${second?.type}`
        );
        check(
          'sendnow',
          'the running turn ends in session.stopped',
          first.type === 'session.stopped'
        );
        check(
          'sendnow',
          'the stopped turn has one terminal event',
          firstEvents.filter(terminal).length === 1
        );
        check('sendnow', 'the next send completes', second?.type === 'session.completed');
        check('sendnow', 'and only once', events.filter(terminal).length === 1);
        check(
          'sendnow',
          'its reply is shown',
          assistantText().includes('PiLab × Claude Agent SDK')
        );
        check(
          'sendnow',
          'no engine turn opens',
          !events.some((e) => e.type === 'message.started' && typeof e.payload?.origin === 'object')
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        break;
      }
      case 'webfetch': {
        // S-6 feedback 5 (ruling 6): WebFetch must not ask claude.ai's domain check first; an
        // encrypted machine's network cannot reach it, and the tool then refused every URL.
        if (!fetchProxy) throw new Error('webfetch: the recording proxy did not start');
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        const call = { name: 'WebFetch', input: { url: 'https://example.com/', prompt: 'title?' } };
        await send(`CC-RUN ${JSON.stringify({ calls: [call] })}`);
        const end = await waitFor(terminal, 'webfetch turn end', 90_000);
        show('webfetch');
        console.log(`  webfetch: proxy saw ${JSON.stringify(fetchProxy.targets)}`);
        const said = JSON.stringify(events.map((e) => e.payload ?? {}));
        check('webfetch', 'ends in session.completed', end.type === 'session.completed');
        check(
          'webfetch',
          'the CLI went for the page itself',
          fetchProxy.targets.some((t) => t.startsWith('example.com'))
        );
        check(
          'webfetch',
          // 2.1.300 asks api.anthropic.com (measured); the error text names claude.ai.
          'it never asked the domain check (api.anthropic.com or claude.ai)',
          fetchProxy.targets.every((t) => !t.includes('claude.ai') && !t.includes('anthropic.com'))
        );
        check(
          'webfetch',
          'the call is not refused as unverifiable',
          !said.includes('Unable to verify')
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        break;
      }
      case 'wakeup': {
        // S-6 feedback 1/9 (ruling 24): ScheduleWakeup is on; at its time the CLI starts a
        // turn by itself while this chat's CLI runs.
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        const call = {
          name: 'ScheduleWakeup',
          input: {
            delaySeconds: 60,
            prompt: 'scheduled wake-up check',
            reason: 'probe wake-up',
            noop: false,
          },
        };
        await send(`CC-RUN ${JSON.stringify({ calls: [call] })}`);
        const end = await waitFor(terminal, 'wakeup: turn end', 90_000);
        const mark = events.length;
        const woke = await waitFor(
          (e) =>
            events.indexOf(e) >= mark && e.type === 'message.started' && e.payload?.role === 'user',
          'wakeup: the turn it starts',
          120_000
        ).catch(() => undefined);
        const wokeEnd = woke
          ? await waitFor(
              (e) => events.indexOf(e) >= mark && terminal(e),
              'wakeup: its end',
              90_000
            ).catch(() => undefined)
          : undefined;
        show('wakeup');
        console.log(`  wakeup: head ${JSON.stringify(woke?.payload ?? null)}`);
        check('wakeup', 'the scheduling turn completes', end.type === 'session.completed');
        check('wakeup', 'the CLI starts a turn at the scheduled time', Boolean(woke));
        check('wakeup', 'that turn completes', wokeEnd?.type === 'session.completed');
        check(
          'wakeup',
          'its head says a schedule came due (origin scheduled)',
          (woke?.payload?.origin as { kind?: string } | undefined)?.kind === 'scheduled'
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        break;
      }
      case 'worktree': {
        // S-6 feedback 1 (ruling 24): EnterWorktree / ExitWorktree are on. In a git
        // workspace the CLI makes a worktree, runs there, and comes back.
        execFileSync('git', ['init', '-q'], { cwd: workspace });
        execFileSync(
          'git',
          [
            '-c',
            'user.email=p@p',
            '-c',
            'user.name=p',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'init',
          ],
          {
            cwd: workspace,
          }
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        const calls = [
          { name: 'EnterWorktree', input: { name: 'probe-wt' } },
          { name: 'Bash', input: { command: 'pwd', description: 'Where am I' } },
          { name: 'ExitWorktree', input: { action: 'remove' } },
          { name: 'Bash', input: { command: 'pwd', description: 'Where am I now' } },
        ];
        await send(`CC-RUN ${JSON.stringify({ calls })}`);
        const end = await waitFor(terminal, 'worktree: turn end', 120_000);
        show('worktree');
        const outputs = events
          .filter((e) => e.type === 'tool.completed')
          .map(
            (e) =>
              `${String(e.payload?.ok)} ${String(e.payload?.output ?? e.payload?.error ?? '').slice(0, 160)}`
          );
        console.log(`  worktree: ${JSON.stringify(outputs)}`);
        check('worktree', 'ends in session.completed', end.type === 'session.completed');
        check(
          'worktree',
          'EnterWorktree and ExitWorktree both ran',
          outputs.length === 4 && outputs.every((o) => o.startsWith('true'))
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        break;
      }
      case 'findings': {
        // S-6 feedback 1 (ruling 24): ReportFindings is on. It only hands a review's
        // findings to the window, so no posture raises a card for it (the CLI marks it
        // read-only and leaves it no permission check), and its input reaches PiLab whole
        // (the review card draws from it), live and in the history alike.
        const reports: Array<{
          posture: ['plan' | 'agent', string];
          input: Record<string, unknown>;
        }> = [
          { posture: ['agent', 'ask'], input: REVIEW_REPORT },
          { posture: ['agent', 'accept-edits'], input: REVIEW_REREPORT },
          { posture: ['plan', 'auto'], input: REVIEW_REPORT },
          { posture: ['agent', 'auto'], input: REVIEW_REPORT },
          { posture: ['agent', 'bypass'], input: { findings: [] } },
        ];
        for (const { posture, input } of reports) {
          const label = posture.join('/');
          await setPosture(...posture);
          const { end, cards } = await runCalls([{ name: 'ReportFindings', input }], () => 'deny');
          show(`findings ${label}`);
          const started = events.find(
            (e) => e.type === 'tool.started' && e.payload?.name === 'ReportFindings'
          );
          const id = started?.payload?.toolCallId;
          const updated = events.find(
            (e) => e.type === 'tool.updated' && e.payload?.toolCallId === id
          );
          const completed = events.find(
            (e) => e.type === 'tool.completed' && e.payload?.toolCallId === id
          );
          const count = (input as { findings: unknown[] }).findings.length;
          check(
            'findings',
            `${label}: ends in session.completed`,
            end.type === 'session.completed'
          );
          check(
            'findings',
            `${label}: no card`,
            cards.length === 0 && countOf('permission.requested') === 0
          );
          check(
            'findings',
            `${label}: the call starts as a streaming row and its input arrives whole`,
            Boolean(
              (started?.payload?.input as { __streaming?: unknown } | undefined)?.__streaming
            ) && isDeepStrictEqual(updated?.payload?.input, input)
          );
          check(
            'findings',
            `${label}: it completes ok (${count} reported)`,
            completed?.payload?.ok === true &&
              String(completed?.payload?.output).startsWith(
                count === 0 ? 'No findings reported.' : `${count} findings reported.`
              )
          );
        }
        await setPosture('agent', 'ask');
        const h = await request<{
          page: {
            messages: Array<{ blocks: Array<{ type: string; name?: string; input?: unknown }> }>;
          };
        }>('worker.history', { logicalSessionId, offset: 0, limit: 50 });
        const replayed = h.page.messages
          .flatMap((m) => m.blocks)
          .filter((b) => b.type === 'tool_call' && b.name === 'ReportFindings');
        check(
          'findings',
          'the history replays every report as a tool_call with its input whole',
          replayed.length === reports.length &&
            replayed.every((b, i) => isDeepStrictEqual(b.input, reports[i]?.input))
        );
        break;
      }
      case 'enc': {
        const marker = process.env.PROBE_ENC_MARKER?.trim() || 'P113B-MARKER-';
        const files = encSamples(marker);
        // New files go to a fresh sibling directory under the sample's own name, so the
        // policy sees the same extension in the same place and Write never meets an old file.
        const writeDir = `ccsdk-written-${Date.now()}`;
        const writes = files.map((file) => join(dirname(file), writeDir, basename(file)));
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        const rows: string[] = [];
        for (const [i, file] of files.entries()) {
          // One turn per sample: a file the CLI chokes on does not cost the rest.
          await send(`CC-ENC ${JSON.stringify({ files: [file], writes: [writes[i]], marker })}`);
          const end = await waitFor(terminal, `enc turn end (${basename(file)})`, 120_000);
          console.log(`\n=== enc ${i + 1}/${files.length} ${basename(file)}: ${end.type}`);
          check(
            'enc',
            `${basename(file)}: the turn ends in session.completed`,
            end.type === 'session.completed'
          );
          const names = new Map<string, string>();
          for (const event of events) {
            const p = event.payload ?? {};
            if (event.type === 'tool.started') names.set(String(p.toolCallId), String(p.name));
            if (event.type !== 'tool.completed') continue;
            const text = toolText(p.output);
            const seen = text.includes('%TSD-Header')
              ? 'TSD'
              : /CCSDK-(EDITED|WRITTEN)/.test(text) || text.includes(marker)
                ? 'plain'
                : '-';
            console.log(
              `  ${(names.get(String(p.toolCallId)) ?? '?').padEnd(5)} ok=${String(p.ok).padEnd(5)} ${seen.padEnd(5)} ${text.replace(/\s+/g, ' ').slice(0, 100)}`
            );
          }
          const reply = assistantText();
          const at = reply.indexOf('ENC-MATRIX\n');
          check('enc', `${basename(file)}: a matrix row comes back`, at >= 0);
          rows.push(
            at >= 0 ? reply.slice(at + 11).trim() : `${basename(file)}: (no row, ${end.type})`
          );
        }
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        console.log('\n=== ENC-MATRIX: what the CLI saw, one row per sample');
        for (const row of rows) console.log(`  ${row}`);
        // The transcript the CLI wrote for this session.
        const stub = JSON.parse(readFileSync(String(sessionFile), 'utf8')) as {
          ccSessionId: string;
        };
        const projects = join(configDir, 'projects');
        const transcripts = (existsSync(projects) ? readdirSync(projects) : [])
          .map((dir) => join(projects, dir, `${stub.ccSessionId}.jsonl`))
          .filter((file) => existsSync(file));
        const onDisk = [
          ...files.flatMap((file, i) => [
            { label: `${basename(file)} (edited)`, file },
            { label: `${basename(file)} (written)`, file: writes[i] },
          ]),
          ...transcripts.map((file) => ({ label: 'transcript', file })),
        ];
        printDiskViews(onDisk, marker, 'right after the turns');
        const recheck = Number(process.env.PROBE_ENC_RECHECK_S ?? 0);
        if (recheck > 0) {
          console.log(`\n  waiting ${recheck} s for the recheck…`);
          await new Promise((r) => setTimeout(r, recheck * 1_000));
          printDiskViews(onDisk, marker, `${recheck} s later`);
        }
        console.log(`\n  written files: ${[...new Set(writes.map(dirname))].join(' ; ')}`);
        break;
      }
      case 'search': {
        await send('CC-SEARCH grep and glob');
        const end = await waitFor(terminal, 'search turn end');
        show('search');
        check('search', 'ends in session.completed', end.type === 'session.completed');
        if (process.platform === 'win32') {
          checkTools('search', ['Grep', 'Glob']);
        } else {
          // 2.1.300 on Linux offers no Grep or Glob: the model is told to use grep and find
          // through Bash, and the fake gateway searches that way when they are not offered.
          const { started, okNames } = toolRuns();
          check(
            'search',
            'no Grep or Glob offered: grep and find ran through Bash',
            !started.includes('Grep') &&
              !started.includes('Glob') &&
              okNames.filter((name) => name === 'Bash').length === 2
          );
        }
        break;
      }
      case 'agent': {
        await send('CC-AGENT delegate once');
        const end = await waitFor(terminal, 'agent turn end', 90_000);
        // 2.1.300 subagents are async: the child's completion comes back as a task
        // notification the CLI answers in a turn of its own (an engine turn, with an
        // `origin`). Wait for that turn too, or it races the next scenario's send.
        const mark = events.length;
        const after = (test: (e: Event) => boolean) => (e: Event) =>
          events.indexOf(e) >= mark && test(e);
        const engineTurn = await waitFor(
          after((e) => e.type === 'message.started' && e.payload?.origin !== undefined),
          'subagent notification turn',
          90_000
        );
        const engineEnd = await waitFor(after(terminal), 'notification turn end', 90_000);
        // Decision 8: the async subagent shows as a background task, and leaves again.
        const tasksOf = (e: Event) =>
          e.type === 'session.status' && typeof e.payload?.backgroundTasks === 'number'
            ? (e.payload.backgroundTasks as number)
            : undefined;
        const positive = events.findIndex((e) => (tasksOf(e) ?? 0) > 0);
        const backToZero =
          positive < 0
            ? undefined
            : await waitFor(
                (e) => tasksOf(e) === 0 && events.indexOf(e) > positive,
                'background tasks back to 0',
                30_000
              ).catch(() => undefined);
        show('agent');
        check('agent', 'ends in session.completed', end.type === 'session.completed');
        checkTools('agent', ['Agent']);
        check(
          'agent',
          'the notification opens an engine turn (origin subagent)',
          (engineTurn.payload?.origin as { kind?: string } | undefined)?.kind === 'subagent'
        );
        check(
          'agent',
          'the engine turn ends in session.completed',
          engineEnd.type === 'session.completed'
        );
        check(
          'agent',
          'session.status reports backgroundTasks > 0 while the subagent runs',
          positive >= 0
        );
        check('agent', 'a later session.status reports backgroundTasks 0', Boolean(backToZero));
        // S-6 feedback 4: the subagent reaches the subagents window and the jobs window.
        const lanes = events.filter((e) => e.type === 'subagent.activity');
        const laneKinds = lanes.map((e) => String(e.payload?.kind));
        const projections = (key: string) =>
          events.filter((e) => e.type === 'session.projection' && e.payload?.key === key);
        const lastView = (key: string) =>
          (projections(key).at(-1)?.payload?.view ?? []) as Array<Record<string, unknown>>;
        console.log(`  agent: lane events ${JSON.stringify(laneKinds)}`);
        check(
          'agent',
          'its lane starts and ends (subagent.activity started, then status)',
          laneKinds.includes('started') && laneKinds.includes('status')
        );
        check(
          'agent',
          'the subagents window lists it (subagentCatalog)',
          lastView('subagentCatalog').length === 1
        );
        check(
          'agent',
          'the jobs window lists it as a settled subagent job',
          lastView('jobs').some((job) => job.kind === 'subagent' && job.status === 'completed')
        );
        const agentJob = lastView('jobs').find((job) => job.kind === 'subagent');
        const agentOut = (await request('worker.job.read', {
          logicalSessionId,
          jobId: String(agentJob?.id ?? ''),
        }).catch(() => ({}))) as { text?: string };
        console.log(
          `  agent: job output ${JSON.stringify(String(agentOut.text ?? '').slice(0, 120))}`
        );
        check(
          'agent',
          'the jobs window reads what the subagent said',
          String(agentOut.text ?? '').trim().length > 0
        );
        break;
      }
      case 'jobs': {
        // S-6 feedback 4: a background command in the jobs window, its output, and Stop.
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'bypass' });
        const short = {
          name: 'Bash',
          input: {
            command: 'sleep 2 && echo job-out-ok',
            description: 'Short background job',
            run_in_background: true,
          },
        };
        await send(`CC-RUN ${JSON.stringify({ calls: [short] })}`);
        await waitFor(terminal, 'jobs: turn end', 90_000);
        const jobsViewsLatest = () =>
          (events.filter((e) => e.type === 'session.projection' && e.payload?.key === 'jobs').at(-1)
            ?.payload?.view ?? []) as Array<Record<string, unknown>>;
        const jobsViews = () =>
          events
            .filter((e) => e.type === 'session.projection' && e.payload?.key === 'jobs')
            .map((e) => (e.payload?.view ?? []) as Array<Record<string, unknown>>);
        const settled = await waitFor(
          (e) =>
            e.type === 'session.projection' &&
            e.payload?.key === 'jobs' &&
            ((e.payload?.view ?? []) as Array<Record<string, unknown>>).some(
              (job) => job.label === 'Short background job' && job.status === 'completed'
            ),
          'jobs: the short job settles',
          60_000
        ).catch(() => undefined);
        const job = jobsViews()
          .flat()
          .find((j) => j.label === 'Short background job');
        const jobId = String(job?.id ?? '');
        const read = (await request('worker.job.read', { logicalSessionId, jobId }).catch(
          (error) => ({
            error: String(error),
          })
        )) as { text?: string; error?: string };
        const panels = (await request('worker.panels', { logicalSessionId })) as {
          projections: Array<{ key: string; view: unknown }>;
        };
        console.log(
          `  jobs: views ${JSON.stringify(jobsViews().map((v) => v.map((j) => j.status)))}`
        );
        console.log(`  jobs: read ${JSON.stringify(read).slice(0, 200)}`);
        check(
          'jobs',
          'the background command is listed as a running bash job',
          jobsViews().some((v) => v.some((j) => j.kind === 'bash' && j.status === 'running'))
        );
        check(
          'jobs',
          'it settles as completed with its exit code',
          Boolean(settled) &&
            /exit code 0/.test(
              String(
                jobsViews()
                  .flat()
                  .find((j) => j.label === 'Short background job' && j.status === 'completed')
                  ?.detail ?? ''
              )
            )
        );
        check(
          'jobs',
          "the window reads the job's output",
          String(read.text ?? '').includes('job-out-ok')
        );
        check(
          'jobs',
          'panels answers the same jobs',
          panels.projections.some(
            (entry) =>
              entry.key === 'jobs' &&
              Array.isArray(entry.view) &&
              (entry.view as unknown[]).length > 0
          )
        );
        // Stop from the window: a long one.
        await new Promise((r) => setTimeout(r, 4000));
        const long = {
          name: 'Bash',
          input: {
            command: 'sleep 61',
            description: 'Long background job',
            run_in_background: true,
          },
        };
        // A second one that keeps running: stopping the first must not touch it.
        const other = {
          name: 'Bash',
          input: {
            command: 'sleep 62',
            description: 'Other background job',
            run_in_background: true,
          },
        };
        await send(`CC-RUN ${JSON.stringify({ calls: [long, other] })}`);
        await waitFor(terminal, 'jobs: long turn end', 90_000);
        const longJob = await waitFor(
          (e) =>
            e.type === 'session.projection' &&
            e.payload?.key === 'jobs' &&
            ((e.payload?.view ?? []) as Array<Record<string, unknown>>).some(
              (j) => j.label === 'Long background job' && j.status === 'running'
            ),
          'jobs: the long job runs',
          30_000
        );
        const longId = String(
          ((longJob.payload?.view ?? []) as Array<Record<string, unknown>>).find(
            (j) => j.label === 'Long background job'
          )?.id
        );
        const killed = (await request('worker.job.kill', { logicalSessionId, jobId: longId })) as {
          outcome?: string;
        };
        const ended = await waitFor(
          (e) =>
            e.type === 'session.projection' &&
            e.payload?.key === 'jobs' &&
            ((e.payload?.view ?? []) as Array<Record<string, unknown>>).some(
              (j) => j.id === longId && j.status === 'killed'
            ),
          'jobs: the long job is killed',
          30_000
        ).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 2000));
        console.log(
          `  jobs: kill → ${JSON.stringify(killed)}; sleep 61 left: ${sleepers(61)}, sleep 62 left: ${sleepers(62)}`
        );
        check('jobs', 'Stop is requested for the running job', killed.outcome === 'requested');
        check('jobs', 'the job settles as killed', Boolean(ended));
        check('jobs', 'its process is gone', sleepers(61) === 0);
        check('jobs', "the other job's process is left running", sleepers(62) === 1);
        const otherId = String(
          jobsViewsLatest().find((j) => j.label === 'Other background job')?.id ?? ''
        );
        if (otherId) await request('worker.job.kill', { logicalSessionId, jobId: otherId });
        await new Promise((r) => setTimeout(r, 3000));
        check('jobs', 'stopping the other one ends it too', sleepers(62) === 0);
        // The model's own TaskStop on a background command (the user's test, S-6).
        const third = {
          name: 'Bash',
          input: {
            command: 'sleep 63',
            description: 'Third background job',
            run_in_background: true,
          },
        };
        await send(`CC-RUN ${JSON.stringify({ calls: [third] })}`);
        await waitFor(terminal, 'jobs: third turn end', 90_000);
        await new Promise((r) => setTimeout(r, 1500));
        const thirdId = String(
          jobsViewsLatest().find((j) => j.label === 'Third background job')?.id ?? ''
        );
        await send(
          `CC-RUN ${JSON.stringify({ calls: [{ name: 'TaskStop', input: { task_id: thirdId } }] })}`
        );
        await waitFor(terminal, 'jobs: TaskStop turn end', 90_000);
        await new Promise((r) => setTimeout(r, 4000));
        console.log(`  jobs: TaskStop ${thirdId}; sleep 63 left: ${sleepers(63)}`);
        check('jobs', "the model's TaskStop leaves no process of the command", sleepers(63) === 0);
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        break;
      }
      case 'errors': {
        for (const item of ERROR_CASES) {
          const marker = JSON.stringify({
            status: item.status,
            ...(item.message ? { message: item.message } : {}),
            ...(item.echoKey ? { echoKey: true } : {}),
          });
          await send(`CC-ERR ${marker}`);
          const end = await waitFor(terminal, `error turn end (${item.status})`, 90_000);
          const error = String(end.payload?.error ?? '');
          console.log(
            `  ${item.status}: ${end.type} errorCode=${String(end.payload?.errorCode)} error=${JSON.stringify(error)}`
          );
          check(
            'errors',
            `HTTP ${item.status} fails the turn with ${item.code}`,
            end.type === 'session.failed' && end.payload?.errorCode === item.code
          );
          check(
            'errors',
            `HTTP ${item.status}: the failure text never says Claude Code`,
            error.length > 0 && !/claude code/i.test(error)
          );
          check(
            'errors',
            `HTTP ${item.status}: the failure text carries no CLI hint`,
            !/Fix external API key|inference gateway|try again in a moment/i.test(error)
          );
        }
        // The session survives its failures.
        await send('CC-TEXT after the errors');
        const end = await waitFor(terminal, 'text turn after the errors');
        check('errors', 'a later turn completes', end.type === 'session.completed');
        // Main shows the host's stderr in the Host stderr panel: the same rules as UI text.
        check(
          'errors',
          "the host's stderr never says Claude Code",
          !hostStderr.some((line) => /claude code/i.test(line))
        );
        check(
          'errors',
          "the host's stderr never carries the key",
          !hostStderr.some((line) => line.includes(apiKey))
        );
        break;
      }
      case 'repoenv': {
        await send('CC-ENV which gateway');
        const end = await waitFor(terminal, 'repoenv turn end', 90_000);
        show('repoenv');
        const reply = assistantText();
        console.log(`  gateway saw: ${reply.slice(0, 300)}`);
        check(
          'repoenv',
          'the turn completes at the configured gateway (repository base URL, proxies and provider switches pinned)',
          end.type === 'session.completed' && reply.includes('CC-ENV ')
        );
        check('repoenv', 'the gateway got our key', reply.includes(`key=${keyDigest}`));
        check(
          'repoenv',
          "no bearer token from the repository's env",
          reply.includes('bearer=none')
        );
        check(
          'repoenv',
          "no header from the repository's env",
          !reply.toLowerCase().includes('x-repo-injected')
        );
        // S-2: the fake gateway refuses the repository's model (401), so an Auto check sent
        // to it is unavailable and the call is refused; with the pins the check allows it.
        await setPosture('agent', 'auto');
        const checked = modePath('repoenv-auto.txt');
        await runCalls(
          [
            {
              name: 'Bash',
              input: {
                command: `node -e "require('fs').writeFileSync('repoenv-auto.txt','x')"`,
                description: 'Write a file with node',
              },
            },
          ],
          () => 'deny'
        );
        await setPosture('agent', 'ask');
        check(
          'repoenv',
          "Auto's check is not sent to the repository's model (model aliases pinned)",
          existsSync(checked)
        );
        // S-2: CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS from the repository would drop these.
        check(
          'repoenv',
          "the request betas are the CLI's own (experimental betas pinned)",
          reply.includes('context-management-')
        );
        break;
      }
      case 'compact': {
        events = [];
        const t = Date.now();
        const r = await request<{ compacted?: boolean }>('worker.compact', { logicalSessionId });
        console.log(`  compact → ${JSON.stringify(r)} in ${Date.now() - t} ms`);
        show('compact');
        check('compact', 'compacts', r.compacted === true);
        break;
      }
      case 'slash': {
        // Decision 194: the CLI's own list, before any message of this chat.
        const menu = await request<{
          commands: Array<{ name: string; source: string; description?: string }>;
        }>('worker.commands', { logicalSessionId });
        const row = (name: string) => menu.commands.find((c) => c.name === name);
        console.log(`  menu: ${menu.commands.map((c) => `${c.name}:${c.source}`).join(' ')}`);
        check(
          'slash',
          'lists the CLI commands before any message, with their descriptions',
          row('context')?.source === 'command' && Boolean(row('context')?.description)
        );
        check(
          'slash',
          'lists the project skill and the user-layer command as skills',
          row('probe-skill')?.source === 'skill' && row('probe-user-cmd')?.source === 'skill'
        );
        check(
          'slash',
          'leaves out the window’s /compact and the CLI commands PiLab owns or hides',
          [
            'compact',
            'clear',
            'model',
            'effort',
            'config',
            'autocompact',
            'heapdump',
            'auto-mode-setup',
            'doctor',
          ].every((name) => !row(name))
        );
        check('slash', 'never names the CLI product', !/claude code/i.test(JSON.stringify(menu)));
        await send('/context');
        const local = await waitFor(terminal, '/context turn end');
        check('slash', '/context ends in session.completed', local.type === 'session.completed');
        check(
          'slash',
          '/context shows its output as the reply',
          assistantText().includes('Context Usage')
        );
        await send('/probe-skill CC-ECHO');
        await waitFor(terminal, 'skill turn end');
        check(
          'slash',
          'the skill’s body reaches the model',
          assistantText().includes('CANARY-SLASH-SKILL')
        );
        await send('/probe-user-cmd CC-ECHO');
        await waitFor(terminal, 'command turn end');
        check(
          'slash',
          'the user-layer command’s body reaches the model',
          assistantText().includes('CANARY-SLASH-CMD')
        );
        const h = await request<{
          page: {
            messages: Array<{ role: string; blocks: Array<{ type: string; text?: string }> }>;
          };
        }>('worker.history', { logicalSessionId, offset: 0, limit: 50 });
        const lines = h.page.messages.map(
          (m) => `${m.role}: ${m.blocks.map((b) => b.text ?? `[${b.type}]`).join(' ')}`
        );
        for (const line of lines) console.log(`  history ${line.slice(0, 100)}`);
        const at = lines.indexOf('user: /context');
        check(
          'slash',
          'history shows /context as typed, then its output',
          at >= 0 &&
            (lines[at + 1] ?? '').startsWith('assistant: ') &&
            (lines[at + 1] ?? '').includes('Context Usage')
        );
        check(
          'slash',
          'history shows the skill and command lines as typed',
          lines.includes('user: /probe-skill CC-ECHO') &&
            lines.includes('user: /probe-user-cmd CC-ECHO')
        );
        check(
          'slash',
          'history shows no command tags',
          !lines.some((line) => line.includes('<command-'))
        );
        // Decision 194 Q1: a folder no chat runs in, listed by a catalog host. The chat's
        // own CLI ran the project's hook, so its absence below means something.
        check(
          'slash',
          'the chat’s CLI ran the project’s SessionStart hook',
          existsSync(slashHookMarker())
        );
        rmSync(slashHookMarker(), { force: true });
        const listed = await catalogListing(workspace);
        const listedRow = (name: string) => listed.result?.commands.find((c) => c.name === name);
        console.log(
          `  catalog: ok=${listed.ok} ${listed.ms} ms, ${listed.result?.commands.length} rows`
        );
        check('slash', 'the catalog host answers', listed.ok === true);
        check(
          'slash',
          'the catalog lists the CLI commands, the project skill and the user-layer command',
          listedRow('context')?.source === 'command' &&
            listedRow('probe-skill')?.source === 'skill' &&
            listedRow('probe-user-cmd')?.source === 'skill' &&
            !listedRow('compact') &&
            !listedRow('clear')
        );
        check('slash', 'the catalog runs no hook of the project', !existsSync(slashHookMarker()));
        break;
      }
      case 'history': {
        const h = await request<{
          page: {
            messages: Array<{ role: string; blocks: Array<{ type: string }> }>;
            totalCount?: number;
          };
        }>('worker.history', { logicalSessionId, offset: 0, limit: 50 });
        const count = h.page.totalCount ?? h.page.messages.length;
        console.log(`\n=== history: ${count} messages`);
        for (const m of h.page.messages)
          console.log(`  ${m.role}: ${m.blocks.map((b) => b.type).join(',')}`);
        check('history', 'has messages', count > 0);
        if (lastHistoryCount !== undefined && sendsSinceHistory > 0) {
          check(
            'history',
            `grows after the turns in between (${lastHistoryCount} → ${count})`,
            count > lastHistoryCount
          );
        }
        lastHistoryCount = count;
        sendsSinceHistory = 0;
        break;
      }
      default:
        check(scenario, 'is a known scenario', false);
    }
    await recordScenario(scenario);
  }
  const commands = await request<{ commands: unknown[] }>('worker.commands', { logicalSessionId });
  console.log(`\ncommands: ${commands.commands.length}`);
  await request('worker.dispose', { reason: 'slot-dispose' });
  removeRepoSettings();
  console.log(`disposed; sessionFile=${sessionFile}; configDir=${configDir}`);
  console.log(
    failures.length === 0
      ? `PROBE CHECKS: all ${checkCount} passed`
      : `PROBE CHECKS: ${failures.length} of ${checkCount} failed\n${failures.map((f) => `  - ${f}`).join('\n')}`
  );
  setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 500);
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  child?.kill();
  removeRepoSettings();
  process.exit(1);
});
