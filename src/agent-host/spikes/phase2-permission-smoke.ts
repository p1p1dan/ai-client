/**
 * Phase 2 smoke: permission.requested → permission.respond(allow) happy path.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/phase2-permission-smoke.ts
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
const PROMPT =
  process.env.AICLIENT_SMOKE_PROMPT ??
  'You MUST call the Write tool to create file .aiclient-perm-smoke.txt with content exactly: PERM-OK. Do not skip the tool. After the tool succeeds, reply with exactly: PERM-OK';
const TIMEOUT_MS = Number(process.env.AICLIENT_SMOKE_TIMEOUT_MS ?? 120000);

interface SmokeReport {
  ok: boolean;
  events: string[];
  sawHostReady: boolean;
  sawPermissionRequested: boolean;
  sawPermissionResolved: boolean;
  sawToolStarted: boolean;
  sawToolCompleted: boolean;
  sawSessionTerminal: boolean;
  permissionId?: string;
  toolName?: string;
  assistantPreview: string;
  error?: string;
}

function send(child: ReturnType<typeof spawn>, cmd: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
}

async function main(): Promise<void> {
  const report: SmokeReport = {
    ok: false,
    events: [],
    sawHostReady: false,
    sawPermissionRequested: false,
    sawPermissionResolved: false,
    sawToolStarted: false,
    sawToolCompleted: false,
    sawSessionTerminal: false,
    assistantPreview: '',
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

  const sessionId = `perm-smoke-${Date.now()}`;
  let settled = false;
  let responded = false;

  const finish = (error?: string) => {
    if (settled) return;
    settled = true;
    if (error) report.error = error;
    report.ok =
      report.sawHostReady &&
      report.sawPermissionRequested &&
      report.sawPermissionResolved &&
      (report.sawToolStarted || report.sawToolCompleted) &&
      report.sawSessionTerminal;
    console.log(
      JSON.stringify({ ...report, stderrTail: stderrChunks.join('').slice(-1200) }, null, 2)
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
      payload?: {
        permissionId?: string;
        toolName?: string;
        text?: string;
        allow?: boolean;
        name?: string;
      };
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      return;
    }
    const type = String(event.type ?? '');
    if (report.events.length < 60) report.events.push(type);

    if (type === 'host.ready') report.sawHostReady = true;
    if (type === 'tool.started') {
      report.sawToolStarted = true;
      report.toolName = event.payload?.name ?? report.toolName;
    }
    if (type === 'tool.completed') report.sawToolCompleted = true;
    if (type === 'message.delta' && typeof event.payload?.text === 'string') {
      const text = event.payload.text;
      if (text && text !== PROMPT) {
        report.assistantPreview = (report.assistantPreview + text).slice(0, 240);
      }
    }
    if (type === 'permission.requested' && event.sessionId === sessionId) {
      report.sawPermissionRequested = true;
      report.permissionId = event.payload?.permissionId;
      report.toolName = event.payload?.toolName ?? report.toolName;
      if (!responded && report.permissionId) {
        responded = true;
        send(child, {
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId: 'perm-allow-1',
          type: 'permission.respond',
          payload: {
            sessionId,
            permissionId: report.permissionId,
            allow: true,
          },
        });
      }
    }
    if (type === 'permission.resolved') report.sawPermissionResolved = true;
    if (type === 'session.completed' || type === 'session.failed' || type === 'session.stopped') {
      report.sawSessionTerminal = true;
      clearTimeout(timeout);
      finish(type === 'session.failed' ? 'session.failed' : undefined);
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
  }, 300);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
