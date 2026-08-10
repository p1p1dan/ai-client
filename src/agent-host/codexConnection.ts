import { spawn } from 'node:child_process';
import type { CodexLaunchPlan } from './codexNodeEntry.ts';
import {
  createLineFramer,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  idKey,
  type JsonRpcErrorBody,
  type JsonRpcId,
  parseFrameLine,
} from './codexWire.ts';

/**
 * The JSON-RPC link to one `codex app-server` process — and the ONLY module in
 * the Host that may touch `child_process` for Codex.
 *
 * ## The second table, and why it is a different table
 *
 * Codex's server requests carry ids from THEIR OWN space, starting at 0
 * [实测: an `item/commandExecution/requestApproval` with `"id":0` arrived in a
 * session where we had already sent an `initialize` with our own id]. Our
 * outbound calls carry ids from OURS. Sharing one map means that the moment both
 * spaces reach the same number, an inbound response settles a server request's
 * entry (or worse, a server request overwrites the promise a caller is awaiting)
 * — a corruption that only shows up under load and looks like a hang.
 *
 * So there are two physically separate tables:
 *   - `outbound` (this file): OUR id -> Promise. Ids start at 1 and only ever
 *     grow. Nothing else may write to it.
 *   - `PendingServerRequestTable` (`codexPending.ts`): THEIR id -> a request we
 *     owe an answer to. This file never looks inside it; it only hands the
 *     runtime the frame via `handlers.onServerRequest`.
 * Starting our ids at 1 is not what makes this safe — the separation is — but it
 * keeps the two spaces visibly distinct in a traffic log.
 *
 * ## One shared routing core, two transports
 *
 * `createCodexConnection` holds every decision (framing, classification,
 * settle, timeout, teardown order) and knows nothing about processes.
 * `spawnCodexConnection` is a thin adapter that pipes a real child's stdio into
 * it. The tests drive the SAME core through an in-memory transport, so what they
 * assert is the code that ships — the alternative (a hand-written fake link)
 * tests a second implementation that no user ever runs.
 *
 * ## Teardown order is load-bearing
 *
 * `dispose()` rejects every outstanding promise BEFORE it kills the process. A
 * killed process cannot answer, so a caller awaiting `thread/start` when the
 * kill lands would otherwise sit on a promise nothing will ever settle — the
 * same permanent-wait failure family as the pending server-request table's
 * "cleared the map without writing a frame". An unexpected exit gets the same
 * treatment for the same reason (arbitration doc §2.3 O-d).
 */

/** Default deadline for a request. Generous: a turn's own work can precede a reply. */
export const CODEX_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Handshake deadline. S1 measured `initialize` at 178–188ms; 15s is a cold
 * start of the 296MiB platform binary plus slack, and is short enough that a
 * wrong entry point (a hung `node <not-codex>.js`) fails while the user is
 * still looking at the screen.
 */
export const CODEX_INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * The link is gone and this call will never be answered.
 *
 * A distinct class, not a generic Error: the runtime has to tell "codex refused
 * our request" (a session-level failure worth reporting) from "we tore the
 * connection down" (expected, during close/shutdown — reporting it would spam
 * `host.error` on every clean exit).
 */
export class CodexConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexConnectionClosedError';
  }
}

/**
 * Codex answered our request with a JSON-RPC `error` body.
 *
 * Not in the original slice contract; added because rejecting with a bare Error
 * loses the numeric code, and the code is the only way a caller can tell
 * `-32601 method not found` (our spelling is wrong — see the [未测] methods in
 * `codexWire.ts`) from a server-side failure of a method that does exist.
 */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, body: JsonRpcErrorBody) {
    super(`codex ${method} failed (${body.code}): ${body.message}`);
    this.name = 'CodexRpcError';
    this.code = body.code;
    if (body.data !== undefined) this.data = body.data;
  }
}

export interface CodexConnection {
  /** Resolves with the `result` member; rejects on error/timeout/teardown. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** Answer one of THEIR requests. `id` comes from the inbound frame, never from us. */
  reply(id: JsonRpcId, result: unknown): void;
  replyError(id: JsonRpcId, code: number, message: string): void;
  /** Reject everything outstanding, then kill. Idempotent. */
  dispose(reason: string): void;
  readonly pid?: number;
  readonly alive: boolean;
}

export interface CodexConnectionHandlers {
  /** Codex is asking US something; the caller owes exactly one reply/replyError. */
  onServerRequest(req: { id: JsonRpcId; method: string; params: unknown }): void;
  onNotification(n: { method: string; params: unknown }): void;
  /** One line, already split. Never a frame — codex logs prose here. */
  onStderr(line: string): void;
  /** Fired at most once, AFTER outstanding promises have been rejected. */
  onExit(info: { code: number | null; signal: string | null }): void;
}

export type CodexConnectFactory = (input: {
  plan: CodexLaunchPlan;
  env: NodeJS.ProcessEnv;
  cwd: string;
  handlers: CodexConnectionHandlers;
}) => CodexConnection;

/**
 * Everything the routing core needs from a process. Implemented once for a real
 * child and once, in the tests, in memory.
 */
export interface CodexTransport {
  /** Write one wire-ready line. The encoders already append `\n`. */
  write(line: string): void;
  /** Terminate. Called at most once per connection. */
  kill(reason: string): void;
  readonly pid?: number;
}

export interface CodexConnectionCore {
  connection: CodexConnection;
  /** Feed a stdout chunk (any framing). */
  pushStdout(chunk: string): void;
  /** Feed a stderr chunk (any framing). */
  pushStderr(chunk: string): void;
  /** The process is gone. Safe to call more than once; only the first counts. */
  handleExit(info: { code: number | null; signal: string | null }): void;
}

interface OutboundCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** stderr is prose, not frames; a smaller cap than stdout's 32MB is plenty. */
const STDERR_BUFFER_MAX_BYTES = 1024 * 1024;

/**
 * The transport-agnostic half. See the module header for the two-table rule and
 * the teardown ordering.
 */
export function createCodexConnection(input: {
  transport: CodexTransport;
  handlers: CodexConnectionHandlers;
  log?: (...args: unknown[]) => void;
}): CodexConnectionCore {
  const { transport, handlers } = input;
  const log = input.log ?? ((...args: unknown[]) => console.error('[codex-connection]', ...args));

  const outbound = new Map<string, OutboundCall>();
  const stdoutFramer = createLineFramer();
  const stderrFramer = createLineFramer(STDERR_BUFFER_MAX_BYTES);

  // Our own id space. 1-based purely so a traffic log stays readable next to
  // theirs (which starts at 0); correctness comes from the separate table.
  let nextId = 1;
  let closed = false;
  let closedReason = '';
  let killed = false;
  let exited = false;
  let overflowReported = false;

  /**
   * A handler supplied by the runtime must never break the read loop: one
   * throwing `onNotification` would otherwise drop every later frame on this
   * connection, including the responses other callers are awaiting.
   */
  function guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      log(`handler ${what} threw:`, err instanceof Error ? err.message : String(err));
    }
  }

  function write(line: string, what: string): boolean {
    if (closed) {
      // Not a throw: the pending-table drain writes its refusal frames during
      // teardown, and a throw there would abort the drain halfway — leaving the
      // remaining requests both registered and unanswered.
      log(`dropped ${what}: connection closed (${closedReason})`);
      return false;
    }
    try {
      transport.write(line);
      return true;
    } catch (err) {
      log(`write failed for ${what}:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  function takeOutbound(): OutboundCall[] {
    const calls = [...outbound.values()];
    outbound.clear();
    for (const call of calls) clearTimeout(call.timer);
    return calls;
  }

  function rejectAll(reason: string): void {
    for (const call of takeOutbound()) {
      call.reject(new CodexConnectionClosedError(`codex ${call.method}: ${reason}`));
    }
  }

  function settleResponse(frame: {
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcErrorBody;
  }): void {
    const key = idKey(frame.id);
    const call = outbound.get(key);
    if (!call) {
      // Already timed out, already torn down, or an id we never sent. Logged and
      // dropped — never routed anywhere else, because "a response we cannot
      // match" must not be mistaken for a notification.
      log('response for unknown request id', key);
      return;
    }
    outbound.delete(key);
    clearTimeout(call.timer);
    if (frame.error) call.reject(new CodexRpcError(call.method, frame.error));
    else call.resolve(frame.result);
  }

  const connection: CodexConnection = {
    request(method: string, params: unknown, timeoutMs: number = CODEX_REQUEST_TIMEOUT_MS) {
      if (closed) {
        // Rejecting immediately rather than registering a promise nothing can
        // ever settle: a caller awaiting a dead connection is a hang, and a hang
        // during teardown is the one this whole module is shaped against.
        return Promise.reject(
          new CodexConnectionClosedError(
            `codex ${method}: connection is closed (${closedReason}), request not sent`
          )
        );
      }
      const id = nextId;
      nextId += 1;
      const key = idKey(id);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Remove FIRST: a late answer must land in the "unknown id" branch
          // above rather than settling an already-rejected promise.
          outbound.delete(key);
          reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // An outstanding deadline must not be the reason the Host cannot exit.
        timer.unref?.();
        // Registered BEFORE the write, so a transport that answers synchronously
        // (the in-memory one, in principle) still finds its entry.
        outbound.set(key, { method, resolve, reject, timer });
        if (!write(encodeRequest(id, method, params), `request ${method}`)) {
          outbound.delete(key);
          clearTimeout(timer);
          reject(new CodexConnectionClosedError(`codex ${method}: could not be written`));
        }
      });
    },

    notify(method: string, params: unknown): void {
      write(encodeNotification(method, params), `notification ${method}`);
    },

    reply(id: JsonRpcId, result: unknown): void {
      write(encodeResult(id, result), `reply to ${idKey(id)}`);
    },

    replyError(id: JsonRpcId, code: number, message: string): void {
      write(encodeError(id, code, message), `error reply to ${idKey(id)}`);
    },

    dispose(reason: string): void {
      const wasOpen = !closed;
      closed = true;
      if (wasOpen) {
        closedReason = reason;
        // ORDER: reject first, kill second. Reversed, a transport whose kill is
        // observable straight away settles these promises with the exit's
        // reason instead of the caller's, and — with a transport that tears down
        // synchronously — could leave them unsettled entirely.
        rejectAll(`connection disposed (${reason})`);
      }
      if (!killed) {
        killed = true;
        try {
          transport.kill(reason);
        } catch (err) {
          log('kill failed:', err instanceof Error ? err.message : String(err));
        }
      }
    },

    get pid(): number | undefined {
      return transport.pid;
    },

    get alive(): boolean {
      return !closed;
    },
  };

  function routeLine(line: string): void {
    const parsed = parseFrameLine(line);
    if (!parsed.ok) {
      // Content is never logged: an unparseable stdout line can hold anything,
      // including whatever the model was writing (T-35).
      log('unparseable stdout line', { error: parsed.error, length: line.length });
      return;
    }
    const frame = parsed.frame;
    switch (frame.kind) {
      case 'server_request':
        guard('onServerRequest', () =>
          handlers.onServerRequest({ id: frame.id, method: frame.method, params: frame.params })
        );
        return;
      case 'response':
        settleResponse(frame);
        return;
      case 'notification':
        guard('onNotification', () =>
          handlers.onNotification({ method: frame.method, params: frame.params })
        );
        return;
      default:
        // `invalid` is a value, not a throw: one bad frame must not take the
        // link down, and the next line is read normally.
        log('invalid frame', { reason: frame.reason });
    }
  }

  return {
    connection,

    pushStdout(chunk: string): void {
      if (closed) {
        log('stdout after close, ignored', { length: chunk.length });
        return;
      }
      for (const line of stdoutFramer.push(chunk)) routeLine(line);
      if (stdoutFramer.overflowed() && !overflowReported) {
        overflowReported = true;
        // Sticky in the framer, reported once here: a frame was permanently
        // lost, so some pending request will only ever end via its timeout.
        log('stdout framer overflowed — at least one frame was dropped');
      }
    },

    pushStderr(chunk: string): void {
      for (const line of stderrFramer.push(chunk)) {
        guard('onStderr', () => handlers.onStderr(line));
      }
    },

    handleExit(info: { code: number | null; signal: string | null }): void {
      if (exited) return;
      exited = true;
      const wasOpen = !closed;
      closed = true;
      if (wasOpen) {
        closedReason = `process exited (code=${String(info.code)}, signal=${String(info.signal)})`;
        // Before `onExit`, deliberately: the runtime's exit handler tears the
        // session down, and a promise still pending at that moment would reject
        // into a session that no longer exists.
        rejectAll(closedReason);
      }
      guard('onExit', () => handlers.onExit(info));
    },
  };
}

/** Grace period between asking codex to stop and insisting. */
const KILL_GRACE_MS = 2_000;

/**
 * The real thing: `node <codex.js> app-server`.
 *
 * NOT unit-tested, on purpose. `protocolErrors.test.ts` is this repo's only
 * suite that starts a real child process, and this slice does not widen that
 * surface. What keeps this function honest is that it owns no routing logic at
 * all — every decision lives in `createCodexConnection`, which the tests drive
 * directly. The parts below that are genuinely untested are the stdio wiring
 * and the kill sequence.
 */
export const spawnCodexConnection: CodexConnectFactory = ({ plan, env, cwd, handlers }) => {
  // `plan.args` is already `[codexJsPath, 'app-server']` and `nodeExecPath` is
  // the Node 24 binary Main resolved. No shell, no PATH lookup: the user ruling
  // is that codex is always launched through its node entry point, and a shell
  // would put `codex` resolution back in play.
  const child = spawn(plan.nodeExecPath, [...plan.args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let lastExit: { code: number | null; signal: string | null } = { code: null, signal: null };

  const core = createCodexConnection({
    transport: {
      get pid(): number | undefined {
        return child.pid;
      },
      write(line: string): void {
        child.stdin?.write(line);
      },
      kill(): void {
        // stdin end first: closing the pipe is how an app-server is asked to
        // finish, and it lets codex flush its own state before the signal.
        try {
          child.stdin?.end();
        } catch {
          /* already gone */
        }
        child.kill('SIGTERM');
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        hard.unref?.();
      },
    },
    handlers,
  });

  child.stdout?.on('data', (chunk: string) => core.pushStdout(chunk));
  child.stderr?.on('data', (chunk: string) => core.pushStderr(chunk));
  // Without a listener an EPIPE on stdin is an unhandled 'error' event, which
  // takes the whole Host process down with it.
  child.stdin?.on('error', (err: Error) => handlers.onStderr(`codex stdin error: ${err.message}`));
  child.on('error', (err: Error) => {
    // Spawn-level failure (ENOENT on the node path, EACCES): no exit event will
    // follow, so this IS the end of the connection.
    handlers.onStderr(`codex spawn failed: ${err.message}`);
    core.handleExit({ code: null, signal: null });
  });
  child.on('exit', (code, signal) => {
    lastExit = { code, signal };
  });
  // `close`, not `exit`: stdio is fully flushed by then, so a final response
  // frame written just before the process ended is still routed.
  child.on('close', () => core.handleExit(lastExit));

  return core.connection;
};
