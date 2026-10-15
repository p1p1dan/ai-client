/**
 * Route-B prototype: drive `host.ts` over IPC the way Main's WorkerSlot does,
 * against the local fake gateway (`--plan claude-sdk`), and print the runtime
 * events each scenario produces.
 *
 *   node tools/host-probe.ts <gatewayUrl> <workspace> [scenario ...]
 *
 * Scenarios: text tools ask stop plan steer agent search enc compact history.
 * Default: text tools ask stop plan steer. Resume: run again with PROBE_CONFIG_DIR and
 * PROBE_SESSION_FILE pointing at the first run's config dir and stub.
 *
 * `enc` is the encrypted-machine matrix (docs/plans/2026-10-14-claude-agent-sdk-prototype.md
 * §5.2). Samples: PROBE_ENC_FILES (absolute paths, `;`-separated) and/or every file of
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
 * The key is a fake one unless PROBE_API_KEY is set in the shell; nothing here reads a
 * stored credential.
 */

import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
      ...(process.env.AICLIENT_CLAUDE_SDK_RG_DIR
        ? { AICLIENT_CLAUDE_SDK_RG_DIR: process.env.AICLIENT_CLAUDE_SDK_RG_DIR }
        : {}),
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
          const reply = events
            .filter((e) => e.type === 'message.delta')
            .map((e) => String(e.payload?.text ?? ''))
            .join('');
          const at = reply.indexOf('ENC-MATRIX\n');
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
