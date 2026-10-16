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
 * declares is neither fetched nor loaded on the host's second start, as the CLI fetches from
 * the second start of a trusted workspace on: the scenario restarts the host itself), `projcfg-home` (the
 * workspace's parent, whose name must contain `fakehome`, stands in for the home directory:
 * its CLAUDE.md is read, its `.claude` is not; on Windows the cwd is given with the drive
 * letter's case flipped) and `projcfg-scratch` (an unbound chat: none of it applies).
 * PROBE_SETTING_SOURCES overrides the host's setting sources (default `project,local`).
 *
 * The key is a fake one unless PROBE_API_KEY is set in the shell; nothing here reads a
 * stored credential.
 */

import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const generation = 1;
let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let events: Event[] = [];
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

function startHost(): void {
  child = fork(hostEntry, [], {
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      APPDATA: process.env.APPDATA ?? '',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
      ProgramFiles: process.env.ProgramFiles ?? '',
      AICLIENT_CLAUDE_SDK_GENERATION: String(generation),
      AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
      AICLIENT_CLAUDE_SDK_BASE_URL: gatewayUrl,
      AICLIENT_CLAUDE_SDK_SETTING_SOURCES: process.env.PROBE_SETTING_SOURCES ?? 'project,local',
      // S-3 P-5: the fake home directory (`projcfg-home`).
      ...(scenarios.includes('projcfg-home') ? { AICLIENT_CLAUDE_SDK_HOME: fakeHome() } : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_RG_DIR
        ? { AICLIENT_CLAUDE_SDK_RG_DIR: process.env.AICLIENT_CLAUDE_SDK_RG_DIR }
        : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_TRACE ? { AICLIENT_CLAUDE_SDK_TRACE: '1' } : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_CLI
        ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Route B S-3 (K-5): the key goes as the first IPC message, as Main sends it. A real
  // gateway key comes from PROBE_API_KEY in this shell only; never a file.
  child.send({ type: 'host.secret', apiKey });
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

function check(scenario: string, label: string, ok: boolean): void {
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

/** sleep.exe processes running exactly `sleep <seconds>` (Windows), so leftovers of other runs do not count. */
function sleepers(seconds: number): number {
  if (process.platform !== 'win32') return processesNamed('sleep');
  const filter = `Name='sleep.exe'`;
  const script = `@(Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.CommandLine -match ' ${seconds}\\s*$' }).Count`;
  return Number(
    execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().trim() || 0
  );
}

function processesNamed(name: string): number {
  if (process.platform !== 'win32')
    return Number(
      execFileSync('sh', ['-c', `pgrep -c ${name} || true`])
        .toString()
        .trim() || 0
    );
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH']).toString();
  return out.split('\n').filter((line) => line.toLowerCase().startsWith(name)).length;
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
  startHost();
  await bootstrap();

  for (const scenario of scenarios) {
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
        const seconds = 97;
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
        // The prototype doc's bar (§5.1): orphans are gone within a few seconds of Stop.
        check(
          'stop',
          'no sleep left 5 s after Stop',
          trail.slice(4).every((n) => n <= before)
        );
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
        await setPosture('plan', 'auto');
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
          'only the read outside the workspace asks; changes are refused with no card',
          cards.join() === 'Read'
        );
        check(
          'mode-plan',
          'the write and the command were refused',
          !existsSync(file) && !existsSync(dir)
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
        // P-9: in plan mode an allow rule runs no change: the command and the write the
        // project's rules allow are refused without a card; exploration still runs.
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
            'plan mode: what the rules allow is refused, exploration runs',
            planned.end.type === 'session.completed' &&
              planned.cards.length === 0 &&
              !existsSync(planTouched) &&
              !existsSync(planWritten) &&
              planOk.join() === 'Bash'
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
          check(scenario, 'no instruction file reaches the model', canaries.length === 0);
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
            'plan mode: with no rule, the changes are refused, exploration runs',
            planned.cards.length === 0 &&
              !existsSync(planTouched) &&
              !existsSync(planWritten) &&
              planOk.join() === 'Bash'
          );
          check(scenario, "the project's hook never runs", hooks.length === 0);
          check(scenario, "the project's settings refuse nothing", refusal === '');
        }
        check(scenario, 'the host started again', second.type === 'session.completed');
        check(scenario, 'the declared plugin was not loaded', !existsSync(pluginMarker));
        check(scenario, 'the declared marketplace was not fetched', traces.length === 0);
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
        checkTools('search', ['Grep', 'Glob']);
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
