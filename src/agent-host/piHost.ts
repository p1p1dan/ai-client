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
import { readExtensionUiResponse } from '../shared/types/runtimeEvents.ts';
import {
  hasSendableContent,
  PERMISSION_PREFERENCE_UNSUPPORTED,
  readAttachments,
  readEffort,
  rejectsPermissionPreference,
} from './piHostCommands.ts';
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
              // Declared FALSE rather than omitted. Omission reads as "old Host
              // build, unknown"; this Host knows the answer — pi's posture lives
              // in the permission plugin's own rules, so no `permissionPreference`
              // sent here would ever be applied, and the renderer must not offer
              // a control that silently does nothing.
              permissionPolicy: false,
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
        if (rejectsPermissionPreference(p)) {
          emitError(cmd.requestId, 'unsupported_capability', PERMISSION_PREFERENCE_UNSUPPORTED);
          return;
        }
        const effort = readEffort(p?.effort);
        if (!effort.ok) {
          emitError(cmd.requestId, 'invalid_payload', `session.create got an unknown effort level`);
          return;
        }
        piRuntime.createSession({
          sessionId,
          workspacePath,
          model: typeof p?.model === 'string' ? p.model : undefined,
          effort: effort.effort,
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
        if (rejectsPermissionPreference(p)) {
          emitError(cmd.requestId, 'unsupported_capability', PERMISSION_PREFERENCE_UNSUPPORTED);
          return;
        }
        const effort = readEffort(p?.effort);
        if (!effort.ok) {
          emitError(cmd.requestId, 'invalid_payload', `session.resume got an unknown effort level`);
          return;
        }
        piRuntime.resumeSession({
          sessionId,
          workspacePath,
          runtimeIdentity,
          model: typeof p?.model === 'string' ? p.model : undefined,
          effort: effort.effort,
          requestId: cmd.requestId,
        });
        break;
      }

      case 'session.send': {
        const p = cmd.payload;
        const sessionId = String(p?.sessionId ?? '');
        const text = String(p?.text ?? '');
        const attachments = readAttachments(p?.attachments);
        if (!attachments.ok) {
          emitError(cmd.requestId, 'invalid_payload', `session.send: ${attachments.reason}`);
          return;
        }
        if (!sessionId || !hasSendableContent(text, attachments.attachments)) {
          emitError(
            cmd.requestId,
            'invalid_payload',
            'session.send requires sessionId and either text or attachments'
          );
          return;
        }
        const effort = readEffort(p?.effort);
        if (!effort.ok) {
          emitError(cmd.requestId, 'invalid_payload', 'session.send got an unknown effort level');
          return;
        }
        void piRuntime
          .send({
            sessionId,
            text,
            ...(attachments.attachments ? { attachments: attachments.attachments } : {}),
            model: typeof p?.model === 'string' ? p.model : undefined,
            effort: effort.effort,
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

      case 'extensionUi.respond': {
        const response = readExtensionUiResponse(cmd.payload);
        if (!response) {
          emitError(
            cmd.requestId,
            'invalid_payload',
            'extensionUi.respond requires runtimeId, uiRequestId and a boolean ok'
          );
          return;
        }
        // A response that settled nothing is NOT an error: the dialog may have
        // timed out, been drained by a session swap, or been answered twice by a
        // renderer that re-mounted. Logged for diagnosis, never surfaced as a
        // failure the user has to act on.
        if (!piRuntime.respondExtensionUi(response)) {
          log('extensionUi.respond matched no pending dialog:', response.uiRequestId);
        }
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
