/**
 * S3 slice-5 G8b: quota-free live positive check for H9.
 *
 * Builds an isolated CODEX_HOME with the PRODUCTION projection code
 * (`ensureCodexHome` + `CODEX_PERMISSION_DEFAULT`), then against a real
 * `codex app-server`:
 *   arm 1  thread/start with the product posture params — echo must pass
 *          `verifyResumePosture` (token-dialect check: config kebab-case vs
 *          echo camelCase).
 *   arm 2  kill, fresh process, thread/resume {threadId} — the DECISIVE arm:
 *          the posture now derives purely from the projected config.toml
 *          [实测: resume re-derives from config, fixtures README S5 section].
 *
 * No turn/start anywhere → zero quota spent.
 *
 * MEASURED (2026-08-15, first run): arm 2 against the arm-1 thread fails with
 * `-32600 no rollout found for thread id <uuid>` — a ZERO-TURN thread has no
 * rollout file, so it cannot be resumed at all. That error string is now pinned
 * in `THREAD_MISSING_PATTERN` (codexRuntime.ts). To run arm 2, copy a
 * rollout-bearing thread's jsonl from the real `~/.codex/sessions/<y>/<m>/<d>/`
 * into the isolated home's sessions tree and resume THAT threadId. Verified
 * PASS both arms (echo `on-request`/`workspaceWrite` from the projected
 * config; the same thread echoed `dangerFullAccess` under the user's real
 * config — positive and negative posture evidence for H9).
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/s5-g8b-posture-probe.ts
 * Env:
 *   S5_G8B_HOME=<dir>    isolated home (default os.tmpdir()/s5-g8b-home)
 *   S5_CODEX_BIN=<path>  default `codex` from PATH
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ensureCodexHome } from '../codexHome.ts';
import { CODEX_PERMISSION_DEFAULT, verifyResumePosture } from '../codexRuntime.ts';

const CODEX_BIN = process.env.S5_CODEX_BIN ?? 'codex';
const HOME_DIR = process.env.S5_G8B_HOME ?? path.join(os.tmpdir(), 's5-g8b-home');
const TIMEOUT_MS = 60_000;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(codexHome: string) {
    this.child = spawn(CODEX_BIN, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome },
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
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
        continue;
      }
      const hasId = msg.id !== undefined && msg.id !== null;
      const method = typeof msg.method === 'string';
      if (hasId && method) {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
        continue;
      }
      if (hasId) {
        const p = this.pending.get(Number(msg.id));
        if (!p) continue;
        this.pending.delete(Number(msg.id));
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, TIMEOUT_MS);
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
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 's5-g8b-posture-probe', title: 'S3 slice-5 G8b', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`
    );
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const ensured = ensureCodexHome({ homeDir: HOME_DIR, permission: CODEX_PERMISSION_DEFAULT });
  console.log('[g8b] isolated home ready:', HOME_DIR, JSON.stringify(ensured).slice(0, 200));

  const cwd = path.join(HOME_DIR, 'sandbox');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd, { recursive: true });

  // Arm 1: thread/start with product posture params.
  const srv1 = new AppServer(HOME_DIR);
  let threadId: unknown;
  try {
    await srv1.handshake();
    const started = (await srv1.request('thread/start', {
      cwd,
      approvalPolicy: CODEX_PERMISSION_DEFAULT.approvalPolicy,
      sandbox: CODEX_PERMISSION_DEFAULT.sandboxMode,
    })) as Record<string, unknown>;
    threadId = (started.thread as Record<string, unknown> | undefined)?.id ?? started.threadId;
    const v1 = verifyResumePosture(CODEX_PERMISSION_DEFAULT, started);
    console.log('[g8b] arm 1 (thread/start echo):', JSON.stringify(v1));
    if (!v1.ok) process.exitCode = 1;
  } finally {
    srv1.kill();
  }

  if (!threadId) {
    console.error('[g8b] no threadId — cannot run arm 2');
    process.exit(1);
  }

  // Arm 2 (decisive): fresh process, posture derives purely from projected config.
  const srv2 = new AppServer(HOME_DIR);
  try {
    await srv2.handshake();
    const resumed = await srv2.request('thread/resume', { threadId });
    const v2 = verifyResumePosture(CODEX_PERMISSION_DEFAULT, resumed);
    console.log('[g8b] arm 2 (thread/resume echo, fresh process):', JSON.stringify(v2));
    if (!v2.ok) process.exitCode = 1;
  } finally {
    srv2.kill();
  }

  console.log(process.exitCode === 1 ? '[g8b] FAIL' : '[g8b] PASS');
  process.exit(process.exitCode ?? 0);
}

void main().catch((e) => {
  console.error('[g8b] probe failed:', e);
  process.exit(1);
});
