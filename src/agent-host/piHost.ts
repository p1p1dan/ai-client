/**
 * Pi Agent Host — Electron utilityProcess entry point.
 *
 * Receives commands via parentPort (MessagePort), dispatches to PiAgentRuntime,
 * streams RuntimeEvents back. Same event format as the NDJSON host so the
 * renderer pipeline requires zero changes.
 *
 * Ref: pix apps/desktop/src/agent-host/index.ts (D3 rev2).
 */

import { AGENT_HOST_PROTOCOL_VERSION } from '../shared/types/agentHost.ts';
import { PiAgentRuntime } from './piRuntime.ts';
import { SessionRegistry } from './sessionRegistry.ts';

// ─── parentPort (Electron utilityProcess) ───

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (ev: { data: unknown }) => void): this;
  start(): void;
}

const parentPort: ElectronParentPort = (() => {
  const port = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
  if (!port) throw new Error('Pi Agent Host must run as an Electron utility process');
  return port;
})();

const PROTOCOL_VERSION = AGENT_HOST_PROTOCOL_VERSION;
let seq = 0;

function emit(event: Record<string, unknown>): void {
  seq += 1;
  parentPort.postMessage({ ...event, seq, timestamp: Date.now() });
}

function log(...args: unknown[]): void {
  console.error('[pi-host]', ...args);
}

process.on('uncaughtException', (error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[pi-host] uncaughtException: ${detail}`);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`[pi-host] unhandledRejection: ${detail}`);
});

// ─── runtime ───

const registry = new SessionRegistry();
const piRuntime = new PiAgentRuntime({ emit, log, registry });

// ─── command handling ───

type HostCommand = {
  type?: string;
  requestId?: string;
  protocolVersion?: number;
  payload?: Record<string, unknown>;
};

function emitError(
  requestId: string | undefined,
  code: string,
  message: string,
  fatal = false
): void {
  emit({
    type: 'host.error',
    requestId,
    payload: { code, message, fatal },
  });
}

async function handleCommand(cmd: HostCommand): Promise<void> {
  if (cmd.protocolVersion !== PROTOCOL_VERSION) {
    emitError(
      cmd.requestId,
      'protocol_mismatch',
      `Expected protocolVersion ${PROTOCOL_VERSION}, got ${String(cmd.protocolVersion)}`
    );
    return;
  }

  try {
    switch (cmd.type) {
      case 'host.initialize': {
        emit({
          type: 'host.ready',
          requestId: cmd.requestId,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            nodeVersion: process.version,
            capabilities: {
              agents: ['pi'],
            },
          },
        });
        break;
      }

      case 'session.create': {
        const p = cmd.payload;
        const sessionId = String(p?.sessionId ?? '');
        const workspacePath = String(p?.workspacePath ?? '');
        if (!sessionId || !workspacePath) {
          emitError(
            cmd.requestId,
            'invalid_payload',
            'session.create requires sessionId and workspacePath'
          );
          return;
        }
        piRuntime.createSession({
          sessionId,
          workspacePath,
          model: typeof p?.model === 'string' ? p.model : undefined,
          requestId: cmd.requestId,
        });
        break;
      }

      case 'session.resume': {
        const p = cmd.payload;
        const sessionId = String(p?.sessionId ?? '');
        const workspacePath = String(p?.workspacePath ?? '');
        const runtimeIdentity = String(p?.runtimeIdentity ?? '');
        if (!sessionId || !workspacePath || !runtimeIdentity) {
          emitError(
            cmd.requestId,
            'invalid_payload',
            'session.resume requires sessionId, workspacePath, runtimeIdentity'
          );
          return;
        }
        piRuntime.resumeSession({
          sessionId,
          workspacePath,
          runtimeIdentity,
          model: typeof p?.model === 'string' ? p.model : undefined,
          requestId: cmd.requestId,
        });
        break;
      }

      case 'session.send': {
        const p = cmd.payload;
        const sessionId = String(p?.sessionId ?? '');
        const text = String(p?.text ?? '');
        if (!sessionId || !text) {
          emitError(cmd.requestId, 'invalid_payload', 'session.send requires sessionId and text');
          return;
        }
        void piRuntime
          .send({
            sessionId,
            text,
            model: typeof p?.model === 'string' ? p.model : undefined,
            requestId: cmd.requestId,
          })
          .catch((err) => {
            log('session.send unhandled:', err);
          });
        break;
      }

      case 'session.stop': {
        const sessionId = String(cmd.payload?.sessionId ?? '');
        if (!sessionId) {
          emitError(cmd.requestId, 'invalid_payload', 'session.stop requires sessionId');
          return;
        }
        piRuntime.stop(sessionId);
        break;
      }

      case 'session.close': {
        const sessionId = String(cmd.payload?.sessionId ?? '');
        if (!sessionId) {
          emitError(cmd.requestId, 'invalid_payload', 'session.close requires sessionId');
          return;
        }
        piRuntime.closeSession(sessionId, cmd.requestId);
        break;
      }

      case 'host.shutdown': {
        await piRuntime.dispose();
        registry.abortAll();
        emit({
          type: 'host.ready',
          requestId: cmd.requestId,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            shuttingDown: true,
          },
        });
        setImmediate(() => process.exit(0));
        break;
      }

      default: {
        log('unhandled command:', cmd.type);
        emitError(cmd.requestId, 'not_implemented', `Unknown command: ${String(cmd.type)}`);
      }
    }
  } catch (error) {
    emitError(
      cmd.requestId,
      'command_failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ─── message loop ───

parentPort.on('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') {
    emitError(undefined, 'invalid_command', 'Command must be an object');
    return;
  }
  void handleCommand(data as HostCommand);
});
parentPort.start();

log('starting', { node: process.version, pid: process.pid });
emit({ type: 'host.hello', payload: { hostPid: process.pid } });
