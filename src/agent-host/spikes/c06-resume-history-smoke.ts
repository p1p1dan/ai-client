/**
 * C-06 smoke: resume history replay end-to-end (Agent SDK, gateway creds).
 *
 * Flow:
 *  1. initialize → host.ready (assert capabilities.history)
 *  2. create session A → send a unique code word → capture session.updated
 *     (runtimeIdentity discovery — the C-06 identity-gap fix) → completed
 *  3. resume session B with A's runtimeIdentity → assert per-session order
 *     session.resumed → session.history → session.status(idle), history
 *     contains the code word and `h:`-prefixed message ids
 *  4. send recall question on B; while it runs, session.resume B again must
 *     be rejected with host.error session_busy (CP4 F-1); assistant answer
 *     must contain the code word (ORANGE-42-style acceptance)
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c06-resume-history-smoke.ts
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
const TIMEOUT_MS = Number(process.env.AICLIENT_SMOKE_TIMEOUT_MS ?? 180000);

const CODE_WORD = `ORANGE-42-C06-${Date.now().toString(36)}`;
const SESSION_A = `c06-a-${Date.now()}`;
const SESSION_B = `c06-b-${Date.now()}`;

interface SmokeReport {
  ok: boolean;
  codeWord: string;
  sawCapabilityHistory: boolean;
  runtimeIdentity: string | null;
  phaseAOk: boolean;
  resumeOrder: string[];
  historyMessageCount: number;
  historyHasCodeWord: boolean;
  historyIdsPrefixed: boolean;
  historyError: unknown;
  sawSessionBusy: boolean;
  recallPreview: string;
  recallHasCodeWord: boolean;
  error?: string;
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

async function main(): Promise<void> {
  const report: SmokeReport = {
    ok: false,
    codeWord: CODE_WORD,
    sawCapabilityHistory: false,
    runtimeIdentity: null,
    phaseAOk: false,
    resumeOrder: [],
    historyMessageCount: 0,
    historyHasCodeWord: false,
    historyIdsPrefixed: false,
    historyError: null,
    sawSessionBusy: false,
    recallPreview: '',
    recallHasCodeWord: false,
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

  let phase: 'init' | 'plant' | 'resume' | 'recall' = 'init';
  let settled = false;
  let busyProbeSent = false;

  const finish = (error?: string) => {
    if (settled) return;
    settled = true;
    if (error) report.error = error;
    report.ok =
      report.sawCapabilityHistory &&
      report.phaseAOk &&
      report.runtimeIdentity !== null &&
      report.resumeOrder.join('>') === 'session.resumed>session.history>session.status' &&
      report.historyMessageCount >= 2 &&
      report.historyHasCodeWord &&
      report.historyIdsPrefixed &&
      report.sawSessionBusy &&
      report.recallHasCodeWord;
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

    if (type === 'host.ready' && phase === 'init') {
      const caps = payload.capabilities as { history?: boolean } | undefined;
      report.sawCapabilityHistory = caps?.history === true;
      phase = 'plant';
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'create-a',
        type: 'session.create',
        payload: { sessionId: SESSION_A, workspacePath: WORKDIR },
      });
      send(child, {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'send-a',
        type: 'session.send',
        payload: {
          sessionId: SESSION_A,
          text: `Remember the code word ${CODE_WORD}. Reply with exactly: OK. Do not use tools.`,
        },
      });
      return;
    }

    if (type === 'session.updated' && event.sessionId === SESSION_A) {
      const identity = payload.runtimeIdentity;
      if (typeof identity === 'string' && identity) report.runtimeIdentity = identity;
      return;
    }

    if (phase === 'plant' && type === 'session.completed' && event.sessionId === SESSION_A) {
      report.phaseAOk = true;
      if (!report.runtimeIdentity) {
        clearTimeout(timeout);
        finish('no session.updated with runtimeIdentity before phase A completed');
        return;
      }
      phase = 'resume';
      // Small settle delay so CC flushes the JSONL before we read it back.
      setTimeout(() => {
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'resume-b',
          type: 'session.resume',
          payload: {
            sessionId: SESSION_B,
            workspacePath: WORKDIR,
            runtimeIdentity: report.runtimeIdentity,
          },
        });
      }, 750);
      return;
    }

    if (phase === 'resume' && event.sessionId === SESSION_B) {
      if (
        report.resumeOrder.length < 3 &&
        (type === 'session.resumed' || type === 'session.history' || type === 'session.status')
      ) {
        report.resumeOrder.push(type);
      }
      if (type === 'session.history') {
        const messages = (payload.messages ?? []) as Array<{
          id?: string;
          blocks?: Array<{ type?: string; text?: string }>;
        }>;
        report.historyMessageCount = messages.length;
        report.historyError = payload.error ?? null;
        report.historyIdsPrefixed =
          messages.length > 0 && messages.every((m) => String(m.id ?? '').startsWith('h:'));
        report.historyHasCodeWord = messages.some((m) =>
          (m.blocks ?? []).some(
            (b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(CODE_WORD)
          )
        );
      }
      if (type === 'session.status' && report.resumeOrder.length === 3) {
        phase = 'recall';
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'send-b',
          type: 'session.send',
          payload: {
            sessionId: SESSION_B,
            text: 'What was the code word? Reply with just the code word. Do not use tools.',
          },
        });
      }
      return;
    }

    if (phase === 'recall' && event.sessionId === SESSION_B) {
      if (type === 'message.delta' && !busyProbeSent) {
        // Turn is running now — resume must be rejected (CP4 F-1).
        busyProbeSent = true;
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'resume-busy-probe',
          type: 'session.resume',
          payload: {
            sessionId: SESSION_B,
            workspacePath: WORKDIR,
            runtimeIdentity: report.runtimeIdentity,
          },
        });
      }
      if (type === 'message.delta') {
        const text = payload.text;
        if (typeof text === 'string') {
          report.recallPreview = (report.recallPreview + text).slice(0, 300);
          if (report.recallPreview.includes(CODE_WORD)) report.recallHasCodeWord = true;
        }
      }
      if (type === 'session.completed' || type === 'session.failed') {
        clearTimeout(timeout);
        finish(type === 'session.failed' ? 'recall turn failed' : undefined);
      }
    }

    if (type === 'host.error') {
      const code = String((payload as { code?: string }).code ?? '');
      if (code === 'session_busy') {
        report.sawSessionBusy = true;
        return;
      }
      if ((payload as { fatal?: boolean }).fatal) {
        clearTimeout(timeout);
        finish(String((payload as { message?: string }).message ?? 'fatal host.error'));
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
