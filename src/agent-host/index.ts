/**
 * Agent Host entry — runs under whitelisted Node 24.
 * Protocol: stdin NDJSON commands → stdout NDJSON Runtime Events; logs on stderr.
 *
 * Phase 2 slice 1: settings.env + Cometix + Agent SDK adapter + Event Normalizer.
 */

import { createInterface } from 'node:readline';
import type { AgentHostDriver, SessionAttachment } from '../shared/types/agentHost.ts';
import { AGENT_HOST_PROTOCOL_VERSION } from '../shared/types/agentHost.ts';
import { ClaudeRuntime } from './claudeRuntime.ts';
import { loadClaudeSettingsEnv } from './claudeSettings.ts';
import { resolveCometixCli } from './cometix.ts';
import { listSessionHistory } from './historyReader.ts';
import { COMETIX_PIN } from './pin.ts';
import { SessionRegistry } from './sessionRegistry.ts';

const PROTOCOL_VERSION = AGENT_HOST_PROTOCOL_VERSION;
let seq = 0;
const envDriver = process.env.AICLIENT_AGENT_HOST_DRIVER;
let driver: AgentHostDriver =
  envDriver === 'stream-json' || envDriver === 'agent-sdk' ? envDriver : 'agent-sdk';
let shuttingDown = false;

const registry = new SessionRegistry();
let runtime: ClaudeRuntime | null = null;
let settingsDiagnostics: Awaited<ReturnType<typeof loadClaudeSettingsEnv>>['diagnostics'] | null =
  null;

function emit(event: Record<string, unknown>): void {
  seq += 1;
  const line = JSON.stringify({
    ...event,
    seq,
    timestamp: Date.now(),
  });
  process.stdout.write(`${line}\n`);
}

function log(...args: unknown[]): void {
  console.error('[agent-host]', ...args);
}

async function ensureRuntime(): Promise<ClaudeRuntime> {
  if (runtime) return runtime;

  const loaded = await loadClaudeSettingsEnv();
  settingsDiagnostics = loaded.diagnostics;
  if (!loaded.diagnostics.loaded) {
    log('claude settings not loaded:', loaded.diagnostics.error);
  } else {
    log('claude settings loaded', {
      path: loaded.diagnostics.settingsPath,
      hasAuthToken: loaded.diagnostics.hasAuthToken,
      hasBaseUrl: loaded.diagnostics.hasBaseUrl,
      baseHost: loaded.diagnostics.baseHost,
      model: loaded.diagnostics.model,
    });
  }

  // Apply settings env onto this process so any nested tools inherit credentials.
  for (const [key, value] of Object.entries(loaded.env)) {
    if (typeof value === 'string' && process.env[key] !== value) {
      process.env[key] = value;
    }
  }

  const cometix = await resolveCometixCli();
  log('cometix resolved', { cliPath: cometix.cliPath, version: cometix.version });

  runtime = new ClaudeRuntime({
    driver,
    cliPath: cometix.cliPath,
    env: loaded.env,
    emit,
    log,
    registry,
  });
  return runtime;
}

async function handleCommand(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') {
    emit({
      type: 'host.error',
      payload: { code: 'invalid_command', message: 'Command must be a JSON object' },
    });
    return;
  }

  const cmd = raw as {
    type?: string;
    requestId?: string;
    protocolVersion?: number;
    payload?: Record<string, unknown>;
  };

  if (cmd.protocolVersion !== PROTOCOL_VERSION) {
    emit({
      type: 'host.error',
      requestId: cmd.requestId,
      payload: {
        code: 'protocol_mismatch',
        message: `Expected protocolVersion ${PROTOCOL_VERSION}, got ${String(cmd.protocolVersion)}`,
      },
    });
    return;
  }

  switch (cmd.type) {
    case 'host.initialize': {
      const payloadDriver = cmd.payload?.driver;
      if (payloadDriver === 'agent-sdk' || payloadDriver === 'stream-json') {
        driver = payloadDriver;
      }
      try {
        await ensureRuntime();
        emit({
          type: 'host.ready',
          requestId: cmd.requestId,
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            driver,
            nodeVersion: process.version,
            nodeExecPath: process.execPath,
            cometixVersion: COMETIX_PIN.version,
            settings: settingsDiagnostics
              ? {
                  loaded: settingsDiagnostics.loaded,
                  hasAuthToken: settingsDiagnostics.hasAuthToken,
                  hasBaseUrl: settingsDiagnostics.hasBaseUrl,
                  baseHost: settingsDiagnostics.baseHost,
                  model: settingsDiagnostics.model,
                }
              : null,
            capabilities: { history: true, thinking: true },
          },
        });
      } catch (err) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'initialize_failed',
            message: err instanceof Error ? err.message : String(err),
            fatal: true,
          },
        });
      }
      return;
    }
    case 'host.shutdown': {
      shuttingDown = true;
      runtime?.dispose();
      registry.abortAll();
      emit({
        type: 'host.ready',
        requestId: cmd.requestId,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          driver,
          nodeVersion: process.version,
          shuttingDown: true,
        },
      });
      setImmediate(() => process.exit(0));
      return;
    }
    case 'session.create': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const workspacePath = String(cmd.payload?.workspacePath ?? '');
      if (!sessionId || !workspacePath) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.create requires sessionId and workspacePath',
            fatal: false,
          },
        });
        return;
      }
      try {
        rt.createSession({
          sessionId,
          workspacePath,
          model: typeof cmd.payload?.model === 'string' ? cmd.payload.model : undefined,
          // Validated in claudeRuntime (normalizeEffort) — unknown values drop.
          effort: cmd.payload?.effort,
          requestId: cmd.requestId,
        });
      } catch (err) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'session_create_failed',
            message: err instanceof Error ? err.message : String(err),
            fatal: false,
          },
        });
      }
      return;
    }
    case 'session.resume': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const workspacePath = String(cmd.payload?.workspacePath ?? '');
      const runtimeIdentity = String(cmd.payload?.runtimeIdentity ?? '');
      if (!sessionId || !workspacePath || !runtimeIdentity) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.resume requires sessionId, workspacePath, runtimeIdentity',
            fatal: false,
          },
        });
        return;
      }
      rt.resumeSession({
        sessionId,
        workspacePath,
        runtimeIdentity,
        model: typeof cmd.payload?.model === 'string' ? cmd.payload.model : undefined,
        // Validated in claudeRuntime (normalizeEffort) — unknown values drop.
        effort: cmd.payload?.effort,
        requestId: cmd.requestId,
      });
      return;
    }
    case 'session.listHistory': {
      const workspacePath = String(cmd.payload?.workspacePath ?? '');
      if (!workspacePath) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.listHistory requires workspacePath',
            fatal: false,
          },
        });
        return;
      }
      // Fire-and-forget: disk scan must not block the command loop.
      void listSessionHistory({ workspacePath })
        .then((result) => {
          emit({
            type: 'session.historyListed',
            requestId: cmd.requestId,
            payload: {
              workspacePath,
              sessions: result.sessions,
              ...(result.error ? { error: result.error } : {}),
            },
          });
        })
        .catch((err) => {
          emit({
            type: 'session.historyListed',
            requestId: cmd.requestId,
            payload: {
              workspacePath,
              sessions: [],
              error: {
                code: 'read_failed',
                message: err instanceof Error ? err.message : String(err),
              },
            },
          });
        });
      return;
    }
    case 'session.send': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const text = String(cmd.payload?.text ?? '');
      const rawAttachments = cmd.payload?.attachments;
      let attachments: SessionAttachment[] | undefined;
      if (rawAttachments !== undefined) {
        if (!Array.isArray(rawAttachments)) {
          emit({
            type: 'host.error',
            requestId: cmd.requestId,
            payload: {
              code: 'invalid_payload',
              message: 'session.send attachments must be an array',
              fatal: false,
            },
          });
          return;
        }
        attachments = [];
        for (const [index, entry] of rawAttachments.entries()) {
          const a = entry as {
            kind?: unknown;
            mediaType?: unknown;
            data?: unknown;
            name?: unknown;
          } | null;
          const valid =
            a &&
            typeof a === 'object' &&
            (a.kind === 'image' || a.kind === 'text') &&
            typeof a.mediaType === 'string' &&
            a.mediaType.length > 0 &&
            typeof a.data === 'string' &&
            a.data.length > 0;
          if (!valid) {
            emit({
              type: 'host.error',
              requestId: cmd.requestId,
              payload: {
                code: 'invalid_payload',
                message: `session.send attachments[${index}] needs kind image|text, mediaType and data`,
                fatal: false,
              },
            });
            return;
          }
          attachments.push({
            kind: a.kind as 'image' | 'text',
            mediaType: a.mediaType as string,
            data: a.data as string,
            ...(typeof a.name === 'string' && a.name ? { name: a.name } : {}),
          });
        }
      }
      if (!sessionId || (!text && !attachments?.length)) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.send requires sessionId and text (or attachments)',
            fatal: false,
          },
        });
        return;
      }
      // Fire-and-forget: events stream on stdout while command loop continues.
      void rt
        .send({
          sessionId,
          text,
          attachments,
          // Validated in claudeRuntime (normalizeEffort) — unknown values drop.
          effort: cmd.payload?.effort,
          // Round-2 P0: per-turn model override, mirrors session.create/resume
          // above. Purely additive on the wire — falls back to the session
          // default in claudeRuntime.send when omitted.
          model: typeof cmd.payload?.model === 'string' ? cmd.payload.model : undefined,
          requestId: cmd.requestId,
        })
        .catch((err) => {
          log('session.send unhandled:', err);
        });
      return;
    }
    case 'session.stop': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      if (!sessionId) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.stop requires sessionId',
            fatal: false,
          },
        });
        return;
      }
      rt.stop({ sessionId, requestId: cmd.requestId });
      return;
    }
    case 'session.close': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      if (!sessionId) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'session.close requires sessionId',
            fatal: false,
          },
        });
        return;
      }
      rt.close({ sessionId, requestId: cmd.requestId });
      return;
    }
    case 'permission.respond': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const permissionId = String(cmd.payload?.permissionId ?? '');
      const allow = Boolean(cmd.payload?.allow);
      if (!sessionId || !permissionId) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message: 'permission.respond requires sessionId and permissionId',
            fatal: false,
          },
        });
        return;
      }
      rt.respondPermission({
        sessionId,
        permissionId,
        allow,
        requestId: cmd.requestId,
      });
      return;
    }
    case 'question.respond': {
      const rt = await ensureRuntime();
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const questionId = String(cmd.payload?.questionId ?? '');
      const rawAnswers = cmd.payload?.answers;
      const answers: Record<string, string> = {};
      if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
        for (const [key, value] of Object.entries(rawAnswers)) {
          if (typeof value === 'string') answers[key] = value;
        }
      }
      const response = typeof cmd.payload?.response === 'string' ? cmd.payload.response : '';
      const cancel = cmd.payload?.cancel === true;
      const hasAnswers = Object.keys(answers).length > 0;
      if (!sessionId || !questionId || (!hasAnswers && !response && !cancel)) {
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'invalid_payload',
            message:
              'question.respond requires sessionId, questionId and one of answers/response/cancel ' +
              '(a bare allow is silently re-asked by the CLI)',
            fatal: false,
          },
        });
        return;
      }
      rt.respondQuestion({
        sessionId,
        questionId,
        ...(hasAnswers ? { answers } : {}),
        ...(response ? { response } : {}),
        ...(cancel ? { cancel } : {}),
        requestId: cmd.requestId,
      });
      return;
    }
    default: {
      log('unhandled command:', cmd.type);
      emit({
        type: 'host.error',
        requestId: cmd.requestId,
        payload: {
          code: 'not_implemented',
          message: `Unknown command: ${String(cmd.type)}`,
          fatal: false,
        },
      });
    }
  }
}

async function main(): Promise<void> {
  log('starting', {
    node: process.version,
    execPath: process.execPath,
    cometix: COMETIX_PIN.version,
    pid: process.pid,
    driver,
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (shuttingDown) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      await handleCommand(JSON.parse(trimmed));
    } catch (err) {
      emit({
        type: 'host.error',
        payload: {
          code: 'parse_error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        },
      });
    }
  }
}

main().catch((err) => {
  log('fatal', err);
  process.exit(1);
});
