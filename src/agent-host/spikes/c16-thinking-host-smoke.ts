/**
 * #8 smoke: does the fixed thinking config produce visible thinking on the real
 * Host protocol, and does `effort` survive the protocol boundary?
 *
 * The c16 probe proved the shape at the SDK layer. This one proves the whole
 * chain the GUI actually uses: spawn src/agent-host/index.ts, speak NDJSON, and
 * assert the normalized Runtime Events (`thinking.started` / `thinking.delta`)
 * arrive with NON-EMPTY text. That is exactly the observable T-04 lacked — the
 * pre-fix config emitted thinking blocks whose text was an empty string, so the
 * card had nothing to render and no error was raised anywhere.
 *
 * Phases:
 *   1. initialize → host.ready
 *   2. session.create (no effort) + reasoning prompt
 *      → assert thinking.started AND thinking.delta with non-empty text
 *   3. session.create with effort:'low' + per-send effort:'high' override
 *      → assert the turn still completes cleanly (protocol accepts effort)
 *   4. session.create with a bogus effort → assert it is dropped, not forwarded
 *      (a rejected value would surface as session.failed / host.error)
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c16-thinking-host-smoke.ts
 *
 * Optional:
 *   AICLIENT_SMOKE_TIMEOUT_MS=240000
 *   AICLIENT_SMOKE_WORKDIR=<path>
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';
import { testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const hostEntry = process.env.AICLIENT_SMOKE_HOST_ENTRY ?? path.join(hostRoot, 'index.ts');

const NODE24 = process.env.AICLIENT_NODE24 ?? process.execPath;
const WORKDIR = process.env.AICLIENT_SMOKE_WORKDIR ?? repoRoot;
const TIMEOUT_MS = Number(process.env.AICLIENT_SMOKE_TIMEOUT_MS ?? 240_000);

const stamp = Date.now();
const SESSION_THINK = `c16-think-${stamp}`;
const SESSION_EFFORT = `c16-effort-${stamp}`;
const SESSION_BOGUS = `c16-bogus-${stamp}`;

const REASONING_PROMPT =
  'Reason carefully step by step, then give the final answer. A freight train leaves at ' +
  '06:40 at 82 km/h; a second leaves at 07:15 at 118 km/h on the same track. When does ' +
  'the second catch the first? Do not use any tools.';
const SHORT_PROMPT = 'What is 6 times 7? Answer with the number only. Do not use tools.';

interface PhaseResult {
  sawThinkingStarted: boolean;
  thinkingTextLen: number;
  thinkingPreview: string;
  completed: boolean;
  failed: boolean;
  failureError?: string;
}

function newPhase(): PhaseResult {
  return {
    sawThinkingStarted: false,
    thinkingTextLen: 0,
    thinkingPreview: '',
    completed: false,
    failed: false,
  };
}

interface SmokeReport {
  ok: boolean;
  hostReady: boolean;
  /** Phase 2 — the T-04 unblock evidence. */
  think: PhaseResult;
  /** Phase 3 — effort accepted through the protocol. */
  effort: PhaseResult;
  /** Phase 4 — bogus effort dropped, not forwarded to the API. */
  bogus: PhaseResult;
  hostErrors: Array<{ code: unknown; message: unknown }>;
  error?: string;
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

async function main(): Promise<void> {
  const report: SmokeReport = {
    ok: false,
    hostReady: false,
    think: newPhase(),
    effort: newPhase(),
    bogus: newPhase(),
    hostErrors: [],
  };

  const child = spawn(NODE24, ['--experimental-strip-types', hostEntry], {
    cwd: hostRoot,
    env: {
      ...process.env,
      ...testCredentialEnv(WORKDIR),
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString('utf8'));
  });

  let settled = false;

  const phaseFor = (sessionId?: string): PhaseResult | null => {
    if (sessionId === SESSION_THINK) return report.think;
    if (sessionId === SESSION_EFFORT) return report.effort;
    if (sessionId === SESSION_BOGUS) return report.bogus;
    return null;
  };

  const finish = (error?: string) => {
    if (settled) return;
    settled = true;
    if (error) report.error = error;
    report.ok =
      report.hostReady &&
      // The core #8 claim: thinking is now observable end-to-end.
      report.think.sawThinkingStarted &&
      report.think.thinkingTextLen > 0 &&
      report.think.completed &&
      !report.think.failed &&
      // effort rides the protocol without breaking the turn.
      report.effort.completed &&
      !report.effort.failed &&
      // A bogus effort is dropped, so the turn still succeeds.
      report.bogus.completed &&
      !report.bogus.failed;
    console.log(
      JSON.stringify({ ...report, stderrTail: stderrChunks.join('').slice(-800) }, null, 2)
    );
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
    let event: {
      type?: string;
      sessionId?: string;
      payload?: Record<string, unknown>;
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      return;
    }
    const type = String(event.type ?? '');
    const payload = event.payload ?? {};

    if (type === 'host.ready' && !report.hostReady) {
      report.hostReady = true;
      // Phase 2: no effort at all — isolates the thinking fix.
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'create-think',
        type: 'session.create',
        payload: { sessionId: SESSION_THINK, workspacePath: WORKDIR },
      });
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'send-think',
        type: 'session.send',
        payload: { sessionId: SESSION_THINK, text: REASONING_PROMPT },
      });
      return;
    }

    if (type === 'host.error') {
      report.hostErrors.push({ code: payload.code, message: payload.message });
      return;
    }

    const phase = phaseFor(event.sessionId);
    if (!phase) return;

    if (type === 'thinking.started') {
      phase.sawThinkingStarted = true;
      return;
    }

    if (type === 'thinking.delta') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      phase.thinkingTextLen += text.length;
      if (!phase.thinkingPreview && text) phase.thinkingPreview = text.slice(0, 240);
      return;
    }

    if (type === 'session.failed') {
      phase.failed = true;
      phase.failureError = String(payload.error ?? '');
    }

    if (type === 'session.completed' || type === 'session.failed') {
      if (type === 'session.completed') phase.completed = true;

      if (event.sessionId === SESSION_THINK) {
        // Phase 3: session default effort 'low', overridden per-send with 'high'.
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'create-effort',
          type: 'session.create',
          payload: { sessionId: SESSION_EFFORT, workspacePath: WORKDIR, effort: 'low' },
        });
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'send-effort',
          type: 'session.send',
          payload: { sessionId: SESSION_EFFORT, text: SHORT_PROMPT, effort: 'high' },
        });
        return;
      }

      if (event.sessionId === SESSION_EFFORT) {
        // Phase 4: garbage effort must be dropped rather than forwarded.
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'create-bogus',
          type: 'session.create',
          payload: { sessionId: SESSION_BOGUS, workspacePath: WORKDIR, effort: 'ludicrous' },
        });
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'send-bogus',
          type: 'session.send',
          payload: { sessionId: SESSION_BOGUS, text: SHORT_PROMPT, effort: 99 },
        });
        return;
      }

      if (event.sessionId === SESSION_BOGUS) {
        clearTimeout(timeout);
        finish();
      }
    }
  });

  child.on('exit', (code) => {
    if (!settled) {
      clearTimeout(timeout);
      finish(`host exited early with code ${code}`);
    }
  });

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'init',
    type: 'host.initialize',
    payload: {},
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
