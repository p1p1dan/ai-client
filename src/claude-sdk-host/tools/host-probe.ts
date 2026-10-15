/**
 * Route-B prototype: drive `host.ts` over IPC the way Main's WorkerSlot does,
 * against the local fake gateway (`--plan claude-sdk`), and print the runtime
 * events each scenario produces.
 *
 *   node tools/host-probe.ts <gatewayUrl> <workspace> [scenario ...]
 *
 * Scenarios: text tools ask stop plan steer compact resume. Default: all but resume.
 * The key is a fake one; nothing here reads a real credential.
 */

import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [gatewayUrl, workspace, ...wanted] = process.argv.slice(2);
if (!gatewayUrl || !workspace)
  throw new Error('usage: host-probe.ts <gatewayUrl> <workspace> [scenario ...]');
const scenarios = wanted.length > 0 ? wanted : ['text', 'tools', 'ask', 'stop', 'plan', 'steer'];
const hostEntry = fileURLToPath(new URL('../host.ts', import.meta.url));
const configDir = process.env.PROBE_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'pilab-ccsdk-home-'));

type Message = Record<string, unknown>;
type Event = { type: string; requestId?: string; payload?: Record<string, unknown> };

let child: ChildProcess;
const generation = 1;
let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let events: Event[] = [];
const waiters: Array<{ test: (e: Event) => boolean; resolve: (e: Event) => void }> = [];
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
      // A real gateway key comes from PROBE_API_KEY in this shell only; never a file.
      AICLIENT_CLAUDE_SDK_API_KEY: process.env.PROBE_API_KEY ?? 'sk-fake-probe-key',
      AICLIENT_CLAUDE_SDK_SETTING_SOURCES: 'project',
      ...(process.env.AICLIENT_CLAUDE_SDK_TRACE ? { AICLIENT_CLAUDE_SDK_TRACE: '1' } : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_REPO_POLICY
        ? { AICLIENT_CLAUDE_SDK_REPO_POLICY: process.env.AICLIENT_CLAUDE_SDK_REPO_POLICY }
        : {}),
      ...(process.env.AICLIENT_CLAUDE_SDK_CLI
        ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() && process.env.PROBE_VERBOSE) console.log(`  [host] ${line}`);
    }
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
  const requestId = `rpc-probe-${++seq}`;
  child.send({ protocolVersion: 1, kind: 'request', generation, requestId, type, payload });
  return new Promise<T>((resolve, reject) =>
    pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject })
  );
}

function waitFor(test: (e: Event) => boolean, label: string, timeoutMs = 60_000): Promise<Event> {
  const seen = events.find(test);
  if (seen) return Promise.resolve(seen);
  return new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({
      test,
      resolve: (e) => {
        clearTimeout(timer);
        resolve(e);
      },
    });
  });
}

const terminal = (e: Event) =>
  e.type === 'session.completed' || e.type === 'session.failed' || e.type === 'session.stopped';

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

async function send(text: string): Promise<string> {
  events = [];
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

async function main(): Promise<void> {
  startHost();
  const t0 = Date.now();
  const boot = await request<Record<string, unknown>>('worker.bootstrap', {
    logicalSessionId,
    cwd: workspace,
    model: 'probe-gw/claude-opus-5-5',
    ...(process.env.PROBE_SESSION_FILE ? { sessionFile: process.env.PROBE_SESSION_FILE } : {}),
  });
  sessionFile = String(boot.sessionFile);
  console.log(
    `bootstrap ${Date.now() - t0} ms: ${JSON.stringify({ ...boot, initialHistory: boot.initialHistory ? `(page of ${(boot.initialHistory as { page: { messages: unknown[] } }).page.messages.length})` : undefined })}`
  );

  for (const scenario of scenarios) {
    switch (scenario) {
      case 'text': {
        await send('CC-TEXT hello');
        await waitFor(terminal, 'text turn end');
        show('text');
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
        await waitFor(terminal, 'tools turn end');
        show('tools');
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
        await waitFor(terminal, 'ask turn end');
        show('ask');
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
        await new Promise((r) => setTimeout(r, 3_000));
        const during = sleepers(seconds);
        const t = Date.now();
        const stopped = await request('worker.stop', { logicalSessionId, reason: 'user' });
        const end = await waitFor(terminal, 'stop turn end', 15_000);
        console.log(
          `  stop → ${JSON.stringify(stopped)}; terminal ${end.type} after ${Date.now() - t} ms`
        );
        const trail: string[] = [];
        for (let i = 1; i <= 12; i += 1) {
          await new Promise((r) => setTimeout(r, 1_000));
          trail.push(`${i}s:${sleepers(seconds)}`);
        }
        console.log(
          `  sleep processes: before=${before} during=${during} after-stop ${trail.join(' ')}`
        );
        await request('worker.setPermissionGear', { logicalSessionId, gear: 'ask' });
        show('stop');
        break;
      }
      case 'plan': {
        await request('worker.setPermissions', {
          logicalSessionId,
          permissions: { mode: 'plan', gear: 'ask' },
        });
        await send('CC-PLAN make a plan');
        const q = await waitFor((e) => e.type === 'question.requested', 'plan review');
        console.log(`  review: ${JSON.stringify(q.payload?.review).slice(0, 200)}`);
        await request('worker.question.respond', {
          logicalSessionId,
          questionId: q.payload?.questionId,
          answers: { 'plan-review': 'run:auto' },
        });
        await waitFor(terminal, 'plan turn end');
        show('plan');
        await request('worker.setPermissions', {
          logicalSessionId,
          permissions: { mode: 'agent', gear: 'ask' },
        });
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
        await waitFor(terminal, 'steer turn end', 90_000);
        show('steer');
        break;
      }
      case 'search': {
        await send('CC-SEARCH grep and glob');
        await waitFor(terminal, 'search turn end');
        show('search');
        break;
      }
      case 'agent': {
        await send('CC-AGENT delegate once');
        await waitFor(terminal, 'agent turn end', 90_000);
        show('agent');
        break;
      }
      case 'compact': {
        events = [];
        const t = Date.now();
        const r = await request('worker.compact', { logicalSessionId });
        console.log(`  compact → ${JSON.stringify(r)} in ${Date.now() - t} ms`);
        show('compact');
        break;
      }
      case 'history': {
        const h = await request<{
          page: { messages: Array<{ role: string; blocks: Array<{ type: string }> }> };
        }>('worker.history', { logicalSessionId, offset: 0, limit: 50 });
        console.log(`\n=== history: ${h.page.messages.length} messages`);
        for (const m of h.page.messages)
          console.log(`  ${m.role}: ${m.blocks.map((b) => b.type).join(',')}`);
        break;
      }
      default:
        console.log(`unknown scenario ${scenario}`);
    }
  }
  const commands = await request<{ commands: unknown[] }>('worker.commands', { logicalSessionId });
  console.log(`\ncommands: ${commands.commands.length}`);
  await request('worker.dispose', { reason: 'slot-dispose' });
  console.log(`disposed; sessionFile=${sessionFile}; configDir=${configDir}`);
  setTimeout(() => process.exit(0), 500);
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  child?.kill();
  process.exit(1);
});
