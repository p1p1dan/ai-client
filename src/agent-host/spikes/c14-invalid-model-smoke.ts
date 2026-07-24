/**
 * C-14 gateway smoke: invalid model must fail explicitly, not hang.
 * Repro basis: C-10 probe observed an invalid model producing zero stream
 * events indefinitely (51s+ observed) with the UI stuck in `running`.
 *
 * Scenario 1 (invalid) — session with model 'not-a-real-model-c14' →
 *   expect session.failed (watchdog stall or upstream API error) within the
 *   watchdog window; never a silent hang.
 * Scenario 2 (control) — plain PONG on the same Host with the watchdog armed →
 *   expect session.completed (watchdog must not break the happy path).
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c14-invalid-model-smoke.ts
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
/** Watchdog window for this smoke — short enough to keep the run tight. */
const STALL_MS = Number(process.env.AICLIENT_C14_STALL_MS ?? 45000);
/** Hard scenario cap: stall window + generous SDK/gateway slack. */
const SCENARIO_TIMEOUT_MS = STALL_MS + 60000;

interface ScenarioReport {
  scenario: 'invalid-model' | 'control-pong';
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  terminal?: string;
  failedError?: string;
  assistantPreview: string;
}

interface HostEvent {
  type?: string;
  sessionId?: string;
  payload?: {
    error?: string;
    text?: string;
    status?: string;
    message?: string;
    fatal?: boolean;
  };
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

function runScenario(
  child: ReturnType<typeof spawn>,
  rl: ReturnType<typeof createInterface>,
  scenario: ScenarioReport['scenario'],
  model?: string
): Promise<ScenarioReport> {
  return new Promise((resolve) => {
    const report: ScenarioReport = {
      scenario,
      ok: false,
      timedOut: false,
      durationMs: 0,
      assistantPreview: '',
    };
    const sessionId = `c14-${scenario}-${Date.now()}`;
    const started = Date.now();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      rl.off('line', onLine);
      clearTimeout(timer);
      report.durationMs = Date.now() - started;
      report.ok =
        !report.timedOut &&
        (scenario === 'invalid-model'
          ? report.terminal === 'session.failed' && Boolean(report.failedError)
          : report.terminal === 'session.completed' && report.assistantPreview.includes('PONG'));
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: `close-${sessionId}`,
        type: 'session.close',
        payload: { sessionId },
      });
      resolve(report);
    };

    const timer = setTimeout(() => {
      report.timedOut = true;
      finish();
    }, SCENARIO_TIMEOUT_MS);

    const onLine = (line: string) => {
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        return;
      }
      if (event.sessionId !== sessionId) return;
      const type = String(event.type ?? '');
      if (type === 'message.delta' && typeof event.payload?.text === 'string') {
        report.assistantPreview = (report.assistantPreview + event.payload.text).slice(0, 240);
      }
      if (type === 'session.failed') {
        report.failedError = String(event.payload?.error ?? '');
      }
      if (type === 'session.completed' || type === 'session.failed' || type === 'session.stopped') {
        report.terminal = type;
        finish();
      }
    };
    rl.on('line', onLine);

    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `create-${sessionId}`,
      type: 'session.create',
      payload: {
        sessionId,
        workspacePath: WORKDIR,
        ...(model ? { model } : {}),
      },
    });
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `send-${sessionId}`,
      type: 'session.send',
      payload: { sessionId, text: 'Reply with exactly: PONG' },
    });
  });
}

async function main(): Promise<void> {
  const child = spawn(NODE24, ['--experimental-strip-types', hostEntry], {
    cwd: hostRoot,
    env: {
      ...process.env,
      ...testCredentialEnv(WORKDIR),
      AICLIENT_AGENT_HOST_DRIVER: 'agent-sdk',
      AICLIENT_HOST_STALL_TIMEOUT_MS: String(STALL_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrChunks: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    stderrChunks.push(buf.toString('utf8'));
  });
  const rl = createInterface({ input: child.stdout! });

  await new Promise<void>((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const event = JSON.parse(line) as HostEvent;
        if (event.type === 'host.ready') {
          rl.off('line', onLine);
          resolve();
        }
        if (event.type === 'host.error' && event.payload?.fatal) {
          rl.off('line', onLine);
          reject(new Error(event.payload.message ?? 'fatal host.error'));
        }
      } catch {
        // ignore non-JSON
      }
    };
    rl.on('line', onLine);
    send(child, {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: 'init-1',
      type: 'host.initialize',
      payload: { driver: 'agent-sdk' },
    });
    setTimeout(() => reject(new Error('host.ready timeout (60s)')), 60000);
  });
  console.error('[c14] host ready, stall window =', STALL_MS);

  console.error('[c14] scenario: invalid-model');
  const invalid = await runScenario(child, rl, 'invalid-model', 'not-a-real-model-c14');
  console.error(
    `[c14] invalid-model: ok=${invalid.ok} terminal=${invalid.terminal} ` +
      `durationMs=${invalid.durationMs} error=${(invalid.failedError ?? '').slice(0, 120)}`
  );

  console.error('[c14] scenario: control-pong');
  const control = await runScenario(child, rl, 'control-pong');
  console.error(
    `[c14] control-pong: ok=${control.ok} terminal=${control.terminal} durationMs=${control.durationMs}`
  );

  const summary = {
    ok: invalid.ok && control.ok,
    stallMs: STALL_MS,
    reports: [invalid, control],
    stderrTail: stderrChunks.join('').slice(-600),
  };
  console.log(JSON.stringify(summary, null, 2));

  send(child, {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    requestId: 'shutdown-1',
    type: 'host.shutdown',
  });
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
    process.exit(summary.ok ? 0 : 2);
  }, 800);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
