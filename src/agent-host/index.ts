/**
 * Agent Host entry — runs under whitelisted Node 24.
 * Protocol: stdin NDJSON commands → stdout NDJSON Runtime Events; logs on stderr.
 *
 * Phase 2 slice 1: settings.env + Cometix + Agent SDK adapter + Event Normalizer.
 */

import { createInterface } from 'node:readline';
import type { AgentHostDriver, SessionAttachment } from '../shared/types/agentHost.ts';
import { AGENT_HOST_PROTOCOL_VERSION } from '../shared/types/agentHost.ts';
import type { AgentWireName } from '../shared/types/agentWire.ts';
import { CODEX_AGENT, resolveAgentWireName, sessionAgent } from '../shared/types/agentWire.ts';
import type { PermissionDecisionId } from '../shared/types/runtimeEvents.ts';
import type { HostAgentRegistry } from './agentSupport.ts';
import {
  describeHostAgentReason,
  ensureHostAgentRegistry,
  initializeHostAgents,
} from './agentSupport.ts';
import { ClaudeRuntime, resolveSubagentActivityEnabled } from './claudeRuntime.ts';
import { loadClaudeSettingsEnv } from './claudeSettings.ts';
import { isPermissionDecisionId } from './codexDecisions.ts';
import { ensureCodexHome } from './codexHome.ts';
import { resolveCodexLaunch } from './codexNodeEntry.ts';
import { CODEX_PERMISSION_DEFAULT, CodexRuntime } from './codexRuntime.ts';
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

/**
 * Refuse a `session.create` / `session.resume` this build cannot honour.
 *
 * Returns true when it emitted the refusal (the caller must stop). Nothing is
 * created: the session must not exist Host-side, must not enter starting/busy,
 * and no runtime is touched — the check runs BEFORE `ensureRuntime()`, like
 * `session.listHistory`'s payload check.
 *
 * Why refusing beats "just run Claude": an absent `agent` is Claude Code (the
 * legacy default — every row written before the field existed is one), but ANY
 * other value means the caller asked for a runtime this build does not have.
 * Silently handing the command to the only runtime present would answer as
 * Claude while the UI says Codex, and on resume it would hand Claude another
 * agent's opaque `runtimeIdentity` (a Codex threadId) as if it were a Claude
 * session id. An unrecognized value is refused for the same reason and not
 * defaulted: it comes from a NEWER build (the user downgraded), so guessing
 * would run the session against the wrong agent.
 *
 * `fatal: false` — this is one bad command, not a broken Host: the process
 * stays usable for every other session. The renderer's send path already
 * treats a request-correlated `host.error` as "this create/resume failed",
 * drops the Host binding and surfaces the message, so no session is left hung.
 *
 * S3 slice 6 (A3/G3): reads `getHostAgentRegistry()` instead of a module-level
 * `SUPPORTED_AGENTS` constant, so an early `session.create`/`session.resume`
 * (before `host.initialize` ever runs) still builds and checks against the
 * real, current-computed list rather than tripping over an unbuilt registry.
 */
function rejectUnsupportedAgent(cmd: {
  type?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}): boolean {
  const requested = cmd.payload?.agent;
  if (requested === undefined || requested === null || requested === '') {
    return false;
  }
  const registry = getHostAgentRegistry();
  if (typeof requested === 'string' && registry.agents.includes(requested as AgentWireName)) {
    return false;
  }
  // S3 slice 6 spec §2 point 7: fold in WHY, when known — flag off / no entry /
  // home prep failed are three different support-log stories, and this reads
  // the same `detail` row the registry already computed rather than guessing.
  const detail = registry.detail.find((d) => d.agent === requested);
  const reasonClue = detail?.reason ? ` — ${describeHostAgentReason(detail.reason)}` : '';
  emit({
    type: 'host.error',
    // Correlated BOTH ways: `requestId` is what the renderer strict-matches
    // on, `sessionId` is what scopes the error to this session's Composer.
    ...(typeof cmd.payload?.sessionId === 'string' && cmd.payload.sessionId
      ? { sessionId: cmd.payload.sessionId }
      : {}),
    requestId: cmd.requestId,
    payload: {
      code: 'agent_unsupported',
      message: `${cmd.type ?? 'command'}: agent ${JSON.stringify(requested)} is not supported by this Host build (supported: ${registry.agents.join(', ')})${reasonClue}`,
      fatal: false,
    },
  });
  return true;
}

const registry = new SessionRegistry();
let runtime: ClaudeRuntime | null = null;
let codexRuntime: CodexRuntime | null = null;
let settingsDiagnostics: Awaited<ReturnType<typeof loadClaudeSettingsEnv>>['diagnostics'] | null =
  null;

/** The runtimes a command can be dispatched to. Each stamps its own agent name. */
type SessionRuntime = ClaudeRuntime | CodexRuntime;

type HostCommand = {
  type?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
};

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

/**
 * Injected by Main (`main/services/agent-host/hostEnv.ts`). Both are values the
 * Host cannot compute: `<userData>/codex-home` needs Electron's `app`, and the
 * app version lives in the packaged `package.json`.
 */
const CODEX_HOME_ENV = 'AICLIENT_CODEX_HOME';
const APP_VERSION_ENV = 'AICLIENT_APP_VERSION';

/**
 * S3 slice 6 (A2): the registry's real entry probe. Pure delegation to
 * `codexNodeEntry.ts` — `agentSupport.ts` never imports that module itself
 * (F14), so the real fs-touching implementation is wired here instead.
 */
function probeCodexEntry(): boolean {
  return resolveCodexLaunch().ok;
}

/**
 * S3 slice 6 (A2): the registry's real home preparation. Same isolated-home
 * recipe `openConnection` runs per session (`codexRuntime.ts`), run once here
 * to DECIDE availability rather than to launch anything — a missing
 * `AICLIENT_CODEX_HOME` throws through `ensureCodexHome` exactly like an empty
 * `homeDir` always has, and `buildHostAgentRegistry` folds that into
 * `home_prepare_failed` (F7: this env is Main-injected and non-empty in
 * production, so that fold-in — not a dedicated reason — is the expected path
 * for a dev/test invocation that skipped Main).
 */
function prepareCodexHome(): void {
  ensureCodexHome({
    homeDir: process.env[CODEX_HOME_ENV]?.trim() ?? '',
    // H9 layer 1 (codexRuntime.ts): the SAME posture object every Codex
    // session's `thread/start` sends, so the registry's availability check
    // prepares the isolated home for the posture sessions will actually run
    // under, not a different one.
    permission: CODEX_PERMISSION_DEFAULT,
    log: (...args: unknown[]) => log('[codex-home]', ...args),
  });
}

/**
 * S3 slice 6 (A1/A3): the single call site every command handler goes through
 * to read the capabilities registry — memoized single-flight in
 * `agentSupport.ts`, so whichever of `host.initialize` / early
 * `session.create` / early `session.resume` calls this FIRST is the one that
 * actually builds it (F15), and every later call just reads that same result.
 */
function getHostAgentRegistry(): HostAgentRegistry {
  return ensureHostAgentRegistry({ probeEntry: probeCodexEntry, prepareHome: prepareCodexHome });
}

/**
 * Build the Codex runtime on first use, or refuse.
 *
 * A missing `AICLIENT_CODEX_HOME` is an explicit `agent_unsupported`, NOT a
 * guessed default: the directory holds a copy of the user's credential and the
 * deny-by-default config projection, so a fallback path would seed both
 * somewhere nobody looks — and would be a second answer to "where is the
 * isolated home", which Main already answers (arbitration doc §4).
 */
function ensureCodexRuntime(cmd: HostCommand): CodexRuntime | null {
  if (codexRuntime) return codexRuntime;
  const codexHomeDir = process.env[CODEX_HOME_ENV]?.trim();
  if (!codexHomeDir) {
    emit({
      type: 'host.error',
      ...(typeof cmd.payload?.sessionId === 'string' && cmd.payload.sessionId
        ? { sessionId: cmd.payload.sessionId }
        : {}),
      requestId: cmd.requestId,
      payload: {
        code: 'agent_unsupported',
        message: `${cmd.type ?? 'command'}: this Host was started without ${CODEX_HOME_ENV}, so the isolated Codex home is unknown and no Codex session can run`,
        fatal: false,
      },
    });
    return null;
  }
  codexRuntime = new CodexRuntime({
    emit,
    log,
    registry,
    codexHomeDir,
    appVersion: process.env[APP_VERSION_ENV] ?? '',
  });
  return codexRuntime;
}

/**
 * THE dispatch. Every command that reaches a runtime goes through this one
 * switch — a second place deciding which runtime owns a session is a second
 * answer, and the two would drift the first time an agent is added (S2 C5).
 *
 * `null` means the refusal has already been emitted and the caller must stop.
 */
async function runtimeForAgent(
  agent: AgentWireName,
  cmd: HostCommand
): Promise<SessionRuntime | null> {
  if (agent === CODEX_AGENT) return ensureCodexRuntime(cmd);
  return ensureRuntime();
}

/**
 * Route by the binding the session was CREATED with, never by the payload: an
 * `agent` field on a send/stop/close would let a mislabeled command hand one
 * runtime another's session. `sessionAgent` is the single fallback point for a
 * session this Host has never heard of — legacy default, i.e. Claude Code,
 * which is exactly what happened before this dispatch existed.
 */
async function runtimeForSession(
  sessionId: string,
  cmd: HostCommand
): Promise<SessionRuntime | null> {
  return runtimeForAgent(sessionAgent(registry.get(sessionId) ?? {}), cmd);
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
      // S3 slice 6 (A4/G4): the registry build and Claude's bootstrap run as
      // two operations that cannot affect each other's outcome — registry
      // FIRST and unconditional, Claude's own try/catch after it, so a Claude
      // `initialize_failed` never clears or skips the registry already built,
      // and a registry that left codex unavailable never blocks Claude.
      const outcome = await initializeHostAgents({
        buildRegistry: getHostAgentRegistry,
        ensureClaudeRuntime: ensureRuntime,
      });
      if (!outcome.claude.ok) {
        const err = outcome.claude.error;
        emit({
          type: 'host.error',
          requestId: cmd.requestId,
          payload: {
            code: 'initialize_failed',
            message: err instanceof Error ? err.message : String(err),
            fatal: true,
          },
        });
        return;
      }
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
                authTokenType: settingsDiagnostics.authTokenType,
                hasBaseUrl: settingsDiagnostics.hasBaseUrl,
                baseHost: settingsDiagnostics.baseHost,
                model: settingsDiagnostics.model,
              }
            : null,
          // T-34: `subagentActivity` reports the FLAG's position, not a
          // build constant — with it off the Host still segregates subagent
          // traffic but forwards nothing, and an empty panel then means
          // "turned off here" rather than "no subagent ran".
          capabilities: {
            history: true,
            thinking: true,
            subagentActivity: resolveSubagentActivityEnabled(),
            // S2 (b): the other half of the `agent_unsupported` loop — the
            // renderer disables the agents missing here instead of finding
            // out by having a create refused. Same registry the refusal
            // enforces against (S3 slice 6 A5), so "advertised" and
            // "accepted" cannot drift.
            agents: [...outcome.registry.agents],
          },
        },
      });
      return;
    }
    case 'host.shutdown': {
      shuttingDown = true;
      runtime?.dispose();
      // Fail-closed on the Codex side too: drain every pending server request
      // (so codex is never left in `waitingOn*`) and kill every app-server.
      codexRuntime?.dispose();
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
      // S2 (b): `payload.agent` is the runtime AND history-reader dispatch key.
      // Checked BEFORE any runtime is built so a refusal costs nothing and
      // leaves no session behind. Whichever runtime handles the command stamps
      // its OWN name on `session.created`; nothing echoes the requested value
      // back unchecked.
      if (rejectUnsupportedAgent(cmd)) return;
      // Past the guard, so this is a supported name or absent (= legacy Claude
      // Code). `resolveAgentWireName` is the single fallback point; `null` is
      // unreachable here because the guard already refused unknown slugs.
      const requestedAgent = resolveAgentWireName(
        typeof cmd.payload?.agent === 'string' ? cmd.payload.agent : undefined
      );
      if (!requestedAgent) return;
      const rt = await runtimeForAgent(requestedAgent, cmd);
      if (!rt) return;
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
      // Same dispatch key as session.create above, but the stakes are higher:
      // `runtimeIdentity` is opaque and only means anything paired with that
      // key, so resuming a foreign handle on the wrong runtime is never an
      // acceptable guess.
      if (rejectUnsupportedAgent(cmd)) return;
      const requestedAgent = resolveAgentWireName(
        typeof cmd.payload?.agent === 'string' ? cmd.payload.agent : undefined
      );
      if (!requestedAgent) return;
      const rt = await runtimeForAgent(requestedAgent, cmd);
      if (!rt) return;
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
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const rt = await runtimeForSession(sessionId, cmd);
      if (!rt) return;
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
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const rt = await runtimeForSession(sessionId, cmd);
      if (!rt) return;
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
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const rt = await runtimeForSession(sessionId, cmd);
      if (!rt) return;
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
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const rt = await runtimeForSession(sessionId, cmd);
      if (!rt) return;
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
      // S3 slice 4: the four-wide decision vocabulary rides ALONGSIDE the
      // historical boolean, and an unknown word is DROPPED rather than
      // forwarded — a decision this build cannot name has no safe meaning, and
      // the runtime would have to guess one.
      const decision = isPermissionDecisionId(cmd.payload?.decision)
        ? cmd.payload.decision
        : undefined;
      // One derivation, not two. `allow` and `decision` come from the same
      // click, so they can only disagree if something upstream is wrong — and
      // the only safe way to settle a disagreement about granting is not to
      // grant. Claude's arm never sends a decision, so it reads `allow` exactly
      // as it always has.
      let effective: PermissionDecisionId = decision ?? (allow ? 'allow' : 'deny');
      if ((effective === 'allow' || effective === 'allow_session') && !allow) {
        log('permission.respond: decision/allow conflict, denying', {
          sessionId,
          permissionId,
          decision,
          allow,
        });
        effective = 'deny';
      }
      rt.respondPermission({
        sessionId,
        permissionId,
        allow: effective === 'allow' || effective === 'allow_session',
        // Only when the renderer actually named one: the Claude runtime's input
        // has no such field, and a synthesized `decision` would put a Codex
        // concept on a call that cannot use it.
        ...(decision !== undefined ? { decision: effective } : {}),
        requestId: cmd.requestId,
      });
      return;
    }
    case 'question.respond': {
      const sessionId = String(cmd.payload?.sessionId ?? '');
      const rt = await runtimeForSession(sessionId, cmd);
      if (!rt) return;
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
