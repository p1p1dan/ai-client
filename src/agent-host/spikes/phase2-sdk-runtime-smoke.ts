/**
 * Phase 2 smoke: Host protocol create → send → stream → stop (Agent SDK).
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/phase2-sdk-runtime-smoke.ts
 *
 * Optional:
 *   AICLIENT_SMOKE_PROMPT="Reply with exactly: PONG. Do not use tools."
 *   AICLIENT_SMOKE_WORKDIR=<path>
 *   AICLIENT_SMOKE_STOP_AFTER_MS=8000   # abort mid-stream to exercise Stop
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const hostEntry = path.join(hostRoot, 'index.ts');

const NODE24 =
  process.env.AICLIENT_NODE24 ??
  process.execPath;
const WORKDIR = process.env.AICLIENT_SMOKE_WORKDIR ?? repoRoot;
const PROMPT =
  process.env.AICLIENT_SMOKE_PROMPT ??
  'Reply with exactly: PONG. Do not use tools.';
const STOP_AFTER_MS = Number(process.env.AICLIENT_SMOKE_STOP_AFTER_MS ?? 0);
const TIMEOUT_MS = Number(process.env.AICLIENT_SMOKE_TIMEOUT_MS ?? 90000);

interface SmokeReport {
  ok: boolean;
  events: string[];
  sawHostReady: boolean;
  sawSessionCreated: boolean;
  sawMessageDelta: boolean;
  sawAssistantText: boolean;
  sawSessionTerminal: boolean;
  sawStopped: boolean;
  assistantPreview: string;
  error?: string;
}

function send(
  child: ReturnType<typeof spawn>,
  cmd: Record<string, unknown>
): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

async function main(): Promise<void> {
  const report: SmokeReport = {
    ok: false,
    events: [],
    sawHostReady: false,
    sawSessionCreated: false,
    sawMessageDelta: false,
    sawAssistantText: false,
    sawSessionTerminal: false,
    sawStopped: false,
    assistantPreview: '',
  };

  const child = spawn(
    NODE24,
    ['--experimental-strip-types', hostEntry],
    {
      cwd: hostRoot,
      env: {
        ...process.env,
        AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString('utf8'));
  });

  const sessionId = `smoke-${Date.now()}`;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const finish = (error?: string) => {
    if (settled) return;
    settled = true;
    if (stopTimer) clearTimeout(stopTimer);
    if (error) report.error = error;
    report.ok =
      report.sawHostReady &&
      report.sawSessionCreated &&
      report.sawMessageDelta &&
      (report.sawAssistantText || report.sawStopped) &&
      (report.sawSessionTerminal || report.sawStopped);
    console.log(JSON.stringify({ ...report, stderrTail: stderrChunks.join('').slice(-800) }, null, 2));
    try {
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: `shutdown-${Date.now()}`,
        type: 'host.shutdown',
      });
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
      process.exitCode = report.ok ? 0 : 2;
    }, 500);
  };

  const timeout = setTimeout(() => finish(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: { type?: string; payload?: { text?: string }; sessionId?: string };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      return;
    }
    const type = String(event.type ?? '');
    if (report.events.length < 40) report.events.push(type);

    if (type === 'host.ready') report.sawHostReady = true;
    if (type === 'session.created') report.sawSessionCreated = true;
    if (type === 'message.delta') {
      report.sawMessageDelta = true;
      const text = event.payload?.text;
      if (typeof text === 'string' && text && event.sessionId === sessionId) {
        // User turn also emits delta; assistant usually arrives after.
        if (text !== PROMPT) {
          report.sawAssistantText = true;
          report.assistantPreview = (report.assistantPreview + text).slice(0, 200);
        }
      }
    }
    if (type === 'session.completed' || type === 'session.failed') {
      report.sawSessionTerminal = true;
      clearTimeout(timeout);
      finish();
    }
    if (type === 'session.stopped') {
      report.sawStopped = true;
      report.sawSessionTerminal = true;
      clearTimeout(timeout);
      finish();
    }
    if (type === 'host.error') {
      const payload = (event as { payload?: { message?: string; fatal?: boolean } }).payload;
      if (payload?.fatal) {
        clearTimeout(timeout);
        finish(payload.message ?? 'fatal host.error');
      }
    }
  });

  child.on('exit', (code) => {
    if (!settled) {
      clearTimeout(timeout);
      finish(`host exited early code=${String(code)}`);
    }
  });

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'init-1',
    type: 'host.initialize',
    payload: { driver: 'agent-sdk' },
  });

  // Small delay so initialize completes before create (stdio is sequential enough usually).
  setTimeout(() => {
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: 'create-1',
      type: 'session.create',
      payload: { sessionId, workspacePath: WORKDIR },
    });
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: 'send-1',
      type: 'session.send',
      payload: { sessionId, text: PROMPT },
    });

    if (STOP_AFTER_MS > 0) {
      stopTimer = setTimeout(() => {
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'stop-1',
          type: 'session.stop',
          payload: { sessionId },
        });
      }, STOP_AFTER_MS);
    }
  }, 300);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
