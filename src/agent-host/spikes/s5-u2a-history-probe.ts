/**
 * S3 slice-5 probe: U2-a — does the item id observed live (`item/completed`)
 * survive reprojection, i.e. equal the item id returned by `thread/read` /
 * `thread/resume` after the fact and across a process restart?
 *
 * Why it matters: slice 5b's history reader replays a Codex thread through the
 * same codexItemMapper used by the live link, minting message ids
 * `h:codex:<threadId>:<itemId>`. Replay-merge dedup against live messages only
 * works if the id spaces coincide. U9 (S2 §0.5-⑤) budgeted exactly ONE real
 * turn for this question; this probe spends it and additionally captures the
 * full `thread/read` / `thread/items/list` / `thread/turns/list` /
 * `thread/resume` response shapes, which exist in no fixture today.
 *
 * Phases:
 *   TURN     one real turn (SPENDS QUOTA): agentMessage + (best effort) one
 *            read-only commandExecution item for id-space variety
 *   REPROJ   same process, free: thread/read, thread/items/list, thread/turns/list
 *   RESTART  fresh app-server process, free: thread/resume (no excludeTurns),
 *            then thread/read again — the true "restart resume" arm (G13 analog)
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s5-u2a-history-probe.ts
 * Env:
 *   S5_OUT_DIR=<path>    default os.tmpdir()/s5-u2a
 *   S5_CODEX_BIN=<path>  default `codex` from PATH
 *   S5_TIMEOUT_MS=180000
 *
 * NOTE (production-path caveat, same as s1/s2 probes): CODEX_BIN here resolves
 * from PATH for convenience; the product resolves node + codex.js explicitly
 * (S2 §0.5-④'). Probe runs against the user's real ~/.codex (same as s1
 * phase 3); the product uses an isolated CODEX_HOME.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CODEX_BIN = process.env.S5_CODEX_BIN ?? 'codex';
const OUT_DIR = process.env.S5_OUT_DIR ?? path.join(os.tmpdir(), 's5-u2a');
const TIMEOUT_MS = Number(process.env.S5_TIMEOUT_MS ?? 180_000);

/** One turn, two item kinds if the model cooperates: a read-only command runs
 *  inside the sandbox without approval under `never` (S1 measured), plus the
 *  final agent message. If the model skips the tool, the probe still answers
 *  U2-a from the agentMessage item alone. */
const PROMPT =
  'First use your shell tool to run exactly: echo u2a-probe . ' +
  'Then reply with exactly DONE and nothing else.';

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

type Envelope = { dir: '->' | '<-' | '!!'; tMs: number; raw: unknown };

async function log(file: string, env: Envelope): Promise<void> {
  await appendFile(path.join(OUT_DIR, file), `${JSON.stringify(env)}\n`);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly notes: Array<{ method: string; params: unknown }> = [];
  private logFile: string;

  constructor(logFile: string) {
    this.logFile = logFile;
    this.child = spawn(CODEX_BIN, ['app-server'], {
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
      // Server request (approval etc.) — this probe should never receive one
      // (approvalPolicy never + read-only), but answer emptily rather than hang.
      this.send({ id: msg.id, result: {} });
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
      clientInfo: { name: 's5-u2a-history-probe', title: 'S3 slice-5 spike', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
    return res;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/** Pull every id-bearing item out of an arbitrary nested structure. */
function collectItems(root: unknown): Array<{ id: unknown; type: unknown; path: string }> {
  const out: Array<{ id: unknown; type: unknown; path: string }> = [];
  const walk = (node: unknown, p: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, `${p}[${i}]`);
      });
      return;
    }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (typeof rec.id === 'string' && (typeof rec.type === 'string' || rec.itemType)) {
        out.push({ id: rec.id, type: rec.type ?? rec.itemType, path: p });
      }
      for (const [k, v] of Object.entries(rec)) walk(v, `${p}.${k}`);
    }
  };
  walk(root, '$');
  return out;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const sandboxCwd = path.join(OUT_DIR, 'sandbox');
  await mkdir(sandboxCwd, { recursive: true });
  const report: Record<string, unknown> = { outDir: OUT_DIR };

  // -------- phase TURN + REPROJ (same process) --------
  const srv = new AppServer('phase-turn.jsonl');
  let threadId: unknown;
  try {
    await srv.handshake();
    const thread = (await srv.request('thread/start', {
      cwd: sandboxCwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })) as Record<string, unknown>;
    threadId = (thread.thread as Record<string, unknown> | undefined)?.id ?? thread.threadId;
    report.threadId = threadId;

    const started = performance.now();
    await srv.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT }],
    });
    await srv.waitFor((m) => m === 'turn/completed' || m === 'error');
    report.turnLatencyMs = Math.round(performance.now() - started);

    const liveItems = srv.notes
      .filter((n) => n.method === 'item/completed' || n.method === 'item/started')
      .map((n) => {
        const item = (n.params as Record<string, unknown> | undefined)?.item as
          | Record<string, unknown>
          | undefined;
        return { via: n.method, id: item?.id, type: item?.type };
      });
    report.liveItems = liveItems;

    // Free local reprojections on the SAME (still-loaded) thread.
    for (const [key, method, params] of [
      ['threadRead', 'thread/read', { threadId }],
      ['threadItemsList', 'thread/items/list', { threadId }],
      ['threadTurnsList', 'thread/turns/list', { threadId }],
    ] as const) {
      try {
        const res = await srv.request(method, params, 30_000);
        report[key] = { ok: true, items: collectItems(res), raw: res };
      } catch (e) {
        report[key] = { ok: false, error: String(e) };
      }
    }
  } catch (e) {
    report.turnError = String(e);
  } finally {
    srv.kill();
  }

  // -------- phase RESTART (fresh process; the G13 analog) --------
  if (threadId) {
    const srv2 = new AppServer('phase-restart.jsonl');
    try {
      await srv2.handshake();
      try {
        const resumed = await srv2.request('thread/resume', { threadId }, 30_000);
        report.threadResume = { ok: true, items: collectItems(resumed), raw: resumed };
      } catch (e) {
        report.threadResume = { ok: false, error: String(e) };
      }
      // Notifications that arrive as a side effect of resume (replayed items?)
      await new Promise((r) => setTimeout(r, 1_500));
      report.resumeNotifications = srv2.notes.map((n) => ({
        method: n.method,
        itemId: (
          (n.params as Record<string, unknown> | undefined)?.item as
            | Record<string, unknown>
            | undefined
        )?.id,
      }));
      try {
        const reread = await srv2.request('thread/read', { threadId }, 30_000);
        report.threadReadAfterRestart = { ok: true, items: collectItems(reread), raw: reread };
      } catch (e) {
        report.threadReadAfterRestart = { ok: false, error: String(e) };
      }
    } catch (e) {
      report.restartError = String(e);
    } finally {
      srv2.kill();
    }
  }

  // -------- verdict --------
  const liveIds = ((report.liveItems as Array<{ id?: unknown }>) ?? [])
    .map((i) => i.id)
    .filter((v): v is string => typeof v === 'string');
  const idsOf = (key: string) =>
    (
      ((report[key] as Record<string, unknown> | undefined)?.items as
        | Array<{ id: unknown }>
        | undefined) ?? []
    )
      .map((i) => i.id)
      .filter((v): v is string => typeof v === 'string');
  const uniq = (a: string[]) => [...new Set(a)];
  report.verdict = {
    liveIds: uniq(liveIds),
    threadReadIds: uniq(idsOf('threadRead')),
    threadResumeIds: uniq(idsOf('threadResume')),
    threadReadAfterRestartIds: uniq(idsOf('threadReadAfterRestart')),
    liveSubsetOfRead: uniq(liveIds).every((id) => idsOf('threadRead').includes(id)),
    liveSubsetOfResume: uniq(liveIds).every((id) => idsOf('threadResume').includes(id)),
    liveSubsetOfReadAfterRestart: uniq(liveIds).every((id) =>
      idsOf('threadReadAfterRestart').includes(id)
    ),
  };

  const outFile = path.join(OUT_DIR, 'report.json');
  await writeFile(outFile, JSON.stringify(report, null, 2));
  console.log(`\n=== S5 U2-A REPORT (also at ${outFile}) ===`);
  console.log(JSON.stringify(report.verdict, null, 2));
  process.exit(0);
}

void main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
