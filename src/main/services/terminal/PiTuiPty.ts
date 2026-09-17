import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PI_PROJECT_TRUST_ENV } from '@shared/piModelConfig';
import type {
  PiTuiDataEvent,
  PiTuiExitEvent,
  PiTuiLaunchLayout,
  PiTuiLaunchPlan,
  PiTuiOpenRequest,
  PiTuiOpenResult,
  PiTuiStatus,
  PiTuiStatusEvent,
} from '@shared/types';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';
import { isCredentialEnvKey } from '../../../../scripts/credential-env-keys.mjs';
import { redactStderrLine } from '../../../agent-host/stderrRedaction';
import { killProcessTree } from '../../utils/processUtils';
import { resolveManagedPiPtyEnv } from '../piModelConfig';
import { buildPiTuiArgs, normalizeSessionKey } from './piTuiSession';

const MAX_SUSPENDED_REPLAY_CHARS = 65_536;
const DEFAULT_MAX_LIVE_TERMINALS = 2;

/** D17: `boundedDimension`'s row floor, below which a resize cannot be a change. */
const REPAINT_MIN_ROWS = 5;

/**
 * terminal-01: how long a disposal waits for the PTY to report that it is gone,
 * and how long it waits again after escalating.
 *
 * Sending the signal is not the event this code needs. The pi CLI installs a
 * SIGHUP handler that tears its runtime down asynchronously and keeps appending
 * to the session file while it does, and node-pty's unix kill swallows its own
 * failures — so "kill returned" says nothing about whether the second writer on
 * that JSONL has stopped. The handover re-reads the file right after this, so
 * answering early is how a chat ends up with two writers.
 */
const DEFAULT_EXIT_CONFIRM_MS = 2_000;
const DEFAULT_FORCE_CONFIRM_MS = 3_000;

/** terminal-03: refused when a warm PTY is asked to serve another chat. */
export const PI_TUI_SESSION_MISMATCH_REASON =
  'This terminal is already running another chat; close it before opening this one';

export type PtyHandle = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'> & {
  /**
   * node-pty always reports one; the test doubles deliberately do not, so a
   * stray escalation in a test cannot name a real process (engineering
   * standard appendix B1).
   */
  readonly pid?: number;
};

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawnFn = (file: string, args: string[], options: PtySpawnOptions) => PtyHandle;

export async function createNodePtySpawn(): Promise<PtySpawnFn> {
  return (file, args, options) => nodePty.spawn(file, args, options);
}

export interface PiTuiCallbacks {
  onData: (event: PiTuiDataEvent) => void;
  onExit: (event: PiTuiExitEvent) => void;
  onState?: (event: PiTuiStatusEvent) => void;
}

interface LiveTerminal {
  terminalId: string;
  cwd: string;
  /** Q17: the JSONL this terminal owns, normalized; '' when it started fresh. */
  sessionKey: string;
  pty: PtyHandle;
  generation: number;
  suspended: boolean;
  replayBuffer: string;
  lastUsed: number;
  /** terminal-01: set from this PTY's own exit event, never from a map lookup. */
  exited: boolean;
  /** terminal-01: disposals parked on that exit event. */
  exitWaiters: Set<() => void>;
}

/** terminal-01: how a request to take a chat's JSONL back actually ended. */
export interface PiTuiDisposeSessionResult {
  /** Terminal ids that owned the session and were asked to stop. */
  terminalIds: string[];
  /**
   * False when at least one of them never reported an exit, even after the
   * escalation. The caller must keep treating the file as contested — releasing
   * ownership here is what makes the GUI the second writer.
   */
  confirmed: boolean;
}

export interface PiTuiControllerOptions {
  /**
   * terminal-01 — the escalation used when the PTY ignores its first kill.
   *
   * Injected rather than called inline: the default reaches `process.kill`
   * through the process-tree helper, and engineering standard appendix B1
   * requires that a test can stub it out (a fabricated pid reaching a real
   * signal is what killed the developer's desktop session on 2026-09-14).
   */
  forceKill?: (pty: PtyHandle) => void;
  exitConfirmMs?: number;
  forceConfirmMs?: number;
}

function boundedDimension(value: number | undefined, minimum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value ?? fallback));
}

/**
 * Where the bundled `pi` CLI is, which Node runs it, and the environment it
 * gets — everything except the arguments.
 *
 * Serves the embedded TUI and, since H/19, the plugin manager, which runs the
 * same binary with `install` / `remove` / `list`. One resolver so a packaged
 * layout fix cannot land for one caller and not the other; the TUI-specific
 * part is `buildPiTuiArgs`, not this.
 */
export function resolvePiCliLaunchPlan(
  layout: PiTuiLaunchLayout,
  inheritedEnv: NodeJS.ProcessEnv = process.env
): PiTuiLaunchPlan {
  const cliPath = layout.isPackaged
    ? join(
        layout.resourcesPath,
        'agent-host',
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js'
      )
    : join(
        layout.appPath,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js'
      );
  if (!existsSync(cliPath)) throw new Error(`Pi CLI artifact is missing: ${cliPath}`);

  const useElectronNode = !layout.isPackaged;
  const nodePath = useElectronNode
    ? layout.electronExecPath
    : join(layout.resourcesPath, 'node-runtime', layout.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value === 'string') env[key] = value;
  }

  const managedEnv = resolveManagedPiPtyEnv();
  // decision 009 — read as the managed-route marker it is, not as a project
  // trust flag: the bundled pi CLI has no such variable and decides project
  // trust on its own (`--approve`, its `trust.json`, `defaultProjectTrust`).
  // The branch is about credentials only — a company-account terminal must not
  // inherit the gateway key from this process.
  if (managedEnv[PI_PROJECT_TRUST_ENV] === '0') {
    for (const key of Object.keys(env)) {
      if (isCredentialEnvKey(key)) delete env[key];
    }
  }
  Object.assign(env, managedEnv);

  env.TERM ||= 'xterm-256color';
  env.COLORTERM ||= 'truecolor';
  if (useElectronNode) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;

  const nodeDir = dirname(nodePath);
  const separator = layout.platform === 'win32' ? ';' : ':';
  const currentPath = env.PATH || env.Path || '';
  const pathEntries = currentPath.split(separator);
  const containsNodeDir = pathEntries.some((entry) =>
    layout.platform === 'win32' ? entry.toLowerCase() === nodeDir.toLowerCase() : entry === nodeDir
  );
  if (!containsNodeDir) {
    env.PATH = currentPath ? `${nodeDir}${separator}${currentPath}` : nodeDir;
    if (layout.platform === 'win32') env.Path = env.PATH;
  }

  // Base argv only. The per-terminal `--session <file>` is appended at spawn
  // time (Q17) because one launch plan serves every terminal in the window.
  return { cliPath, nodePath, args: [cliPath], env, useElectronNode };
}

export class PiTuiPtyController {
  readonly windowId: number;
  readonly #spawn: PtySpawnFn;
  readonly #resolveLaunch: () => Promise<PiTuiLaunchPlan>;
  readonly #live = new Map<string, LiveTerminal>();
  readonly #chains = new Map<string, Promise<void>>();
  readonly #generations = new Map<string, number>();
  readonly #callbacks: PiTuiCallbacks;
  readonly #maxLiveTerminals: number;
  readonly #forceKill: (pty: PtyHandle) => void;
  readonly #exitConfirmMs: number;
  readonly #forceConfirmMs: number;
  #openChain: Promise<void> = Promise.resolve();
  #disposed = false;
  #usageSequence = 0;

  constructor(
    windowId: number,
    callbacks: PiTuiCallbacks,
    spawn: PtySpawnFn,
    resolveLaunch: () => Promise<PiTuiLaunchPlan>,
    maxLiveTerminals = DEFAULT_MAX_LIVE_TERMINALS,
    options: PiTuiControllerOptions = {}
  ) {
    this.windowId = windowId;
    this.#callbacks = callbacks;
    this.#spawn = spawn;
    this.#resolveLaunch = resolveLaunch;
    this.#maxLiveTerminals = Math.max(1, Math.floor(maxLiveTerminals));
    this.#forceKill = options.forceKill ?? ((pty) => killProcessTree(pty, 'SIGKILL'));
    this.#exitConfirmMs = options.exitConfirmMs ?? DEFAULT_EXIT_CONFIRM_MS;
    this.#forceConfirmMs = options.forceConfirmMs ?? DEFAULT_FORCE_CONFIRM_MS;
  }

  open(request: PiTuiOpenRequest): Promise<PiTuiOpenResult> {
    const terminalId = request.terminalId.trim();
    const cwd = request.cwd.trim();
    if (!terminalId || !cwd) throw new Error('terminalId and cwd are required');
    const result = this.#openChain.then(() =>
      this.#enqueue(terminalId, () => this.#openExclusive({ ...request, terminalId, cwd }))
    );
    this.#openChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #openExclusive(request: PiTuiOpenRequest): Promise<PiTuiOpenResult> {
    if (this.#disposed) throw new Error('Pi TUI controller is disposed');
    const requestedKey = normalizeSessionKey(request.sessionFile ?? '');
    const current = this.#live.get(request.terminalId);
    if (current) {
      // terminal-03 — a warm PTY is bound to the JSONL it was spawned on, and
      // this branch used to ignore the request's session entirely. Resuming it
      // for another chat put everything the user typed into the previous chat's
      // file while the UI said they were somewhere else. An empty request key
      // is "no claim" (the revive path passes whatever the chat row has, which
      // is nothing until the first send binds a runtime), not "another chat".
      if (requestedKey && requestedKey !== current.sessionKey) {
        throw new Error(PI_TUI_SESSION_MISMATCH_REASON);
      }
      current.suspended = false;
      current.lastUsed = ++this.#usageSequence;
      this.#resizeNow(current.pty, request.cols, request.rows);
      this.#emitState(request.terminalId, 'live');
      if (current.replayBuffer) {
        this.#callbacks.onData({ terminalId: request.terminalId, data: current.replayBuffer });
        current.replayBuffer = '';
      }
      // D17 — a parked pi that produced nothing has an empty replay buffer, and
      // the renderer rebuilt its xterm with an empty scrollback: the screen
      // comes back blank while the PTY is alive and still echoing keystrokes.
      // Nobody owns the repaint at that seam, so half of it is arranged here —
      // after the replay, so the repaint lands on top of the replayed bytes.
      this.#primeRepaint(current.pty, request.cols, request.rows);
      return {
        terminalId: request.terminalId,
        generation: current.generation,
        resumed: true,
      };
    }

    this.#reserveCapacity();
    const launch = await this.#resolveLaunch();
    if (this.#disposed) throw new Error('Pi TUI controller is disposed');
    this.#reserveCapacity();
    const generation = (this.#generations.get(request.terminalId) ?? 0) + 1;
    this.#generations.set(request.terminalId, generation);
    const prompt = request.initialPrompt?.trim();
    const args = buildPiTuiArgs(launch.cliPath, request.sessionFile);
    const pty = this.#spawn(launch.nodePath, args, {
      name: 'xterm-256color',
      cols: boundedDimension(request.cols, 20, 80),
      rows: boundedDimension(request.rows, 5, 24),
      cwd: request.cwd,
      env: launch.env,
    });
    // T066: terminal mode starts a second process on the user's session file
    // and, until now, said nothing anywhere — not the spawn, not the exit, not
    // the exit code. The argv summary is safe by construction: the environment
    // is never printed, and the initial prompt is written to stdin below
    // precisely so it stays out of argv and process listings. Paths are
    // redacted (T042).
    console.log(
      `[pi-tui] Spawned terminal ${request.terminalId} (generation ${generation}): ${redactStderrLine(
        [launch.nodePath, ...args].join(' ')
      )} in ${redactStderrLine(request.cwd)}`
    );
    const live: LiveTerminal = {
      terminalId: request.terminalId,
      cwd: request.cwd,
      sessionKey: requestedKey,
      pty,
      generation,
      suspended: false,
      replayBuffer: '',
      lastUsed: ++this.#usageSequence,
      exited: false,
      exitWaiters: new Set(),
    };
    this.#live.set(request.terminalId, live);

    pty.onData((data) => {
      const active = this.#live.get(request.terminalId);
      if (!active || active.pty !== pty || active.generation !== generation) return;
      if (active.suspended) {
        active.replayBuffer = `${active.replayBuffer}${data}`.slice(-MAX_SUSPENDED_REPLAY_CHARS);
        return;
      }
      this.#callbacks.onData({ terminalId: request.terminalId, data });
    });
    pty.onExit((event) => {
      // terminal-01: mark the record, not the map entry. A disposal unbooks the
      // terminal before it starts waiting, so a map lookup here would miss
      // exactly the exit a caller is parked on.
      live.exited = true;
      // T066: one line per exit, carrying the code the field pass could not
      // find anywhere. A non-zero exit is an anomaly and goes to `warn`, which
      // is the level that survives with the logging switch off; a clean exit is
      // a milestone and stays at info.
      const exitSummary = `[pi-tui] Terminal ${request.terminalId} exited (code=${event.exitCode} signal=${event.signal ?? 'none'})`;
      if (event.exitCode === 0) console.log(exitSummary);
      else console.warn(exitSummary);
      for (const waiter of [...live.exitWaiters]) waiter();
      const active = this.#live.get(request.terminalId);
      if (!active || active.pty !== pty || active.generation !== generation) return;
      this.#live.delete(request.terminalId);
      this.#emitState(request.terminalId, 'dead');
      this.#callbacks.onExit({
        terminalId: request.terminalId,
        ...event,
        // Q17: Main releases session ownership on this event, so it has to say
        // which session died — the live entry is already gone by now.
        ...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
      });
    });
    this.#emitState(request.terminalId, 'live');
    // Keep prompts out of argv/process listings. PTYs buffer early input until
    // the CLI has installed its stdin handler, so no timing sleep is required.
    if (prompt) pty.write(`\x1b[200~${prompt}\x1b[201~\r`);
    return { terminalId: request.terminalId, generation, resumed: false };
  }

  write(terminalId: string, data: string): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (!live || live.suspended) throw new Error('Pi TUI is not open');
      live.pty.write(data);
    });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (live) this.#resizeNow(live.pty, cols, rows);
    });
  }

  suspend(terminalId: string): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (!live) return;
      live.suspended = true;
      live.lastUsed = ++this.#usageSequence;
      this.#emitState(terminalId, 'suspended');
    });
  }

  /**
   * Stop this terminal and wait until its process is actually gone.
   *
   * terminal-01 — resolves `true` when the PTY reported its exit, `false` when
   * it never did. A `false` here is not cosmetic: the caller uses it to decide
   * whether the chat's JSONL is safe for the GUI to write.
   */
  dispose(terminalId: string): Promise<boolean> {
    return this.#enqueue(terminalId, () => this.#disposeAndConfirm(terminalId));
  }

  /**
   * Q17: kill every terminal that owns `sessionFile`, so the GUI worker can
   * take the JSONL back. Reports the terminal ids that were asked to stop and
   * whether all of them were seen to exit — the caller releases the ownership
   * guard only on the confirmed case (terminal-01).
   *
   * Matching is on the normalized key, not the raw string: a path that reached
   * the controller through `realpath` and one that came from an index row can
   * differ by `/private` or case and still name the same file.
   */
  async disposeSession(sessionFile: string): Promise<PiTuiDisposeSessionResult> {
    const key = normalizeSessionKey(sessionFile);
    if (!key) return { terminalIds: [], confirmed: true };
    const targets = [...this.#live.values()]
      .filter((live) => live.sessionKey === key)
      .map((live) => live.terminalId);
    const settled = await Promise.allSettled(targets.map((terminalId) => this.dispose(terminalId)));
    const confirmed = settled.every((result) => result.status === 'fulfilled' && result.value);
    return { terminalIds: targets, confirmed };
  }

  async disposeAll(): Promise<void> {
    this.#disposed = true;
    await Promise.allSettled([this.#openChain, ...this.#chains.values()]);
    this.disposeAllSync();
  }

  disposeAllSync(): void {
    this.#disposed = true;
    for (const terminalId of [...this.#live.keys()]) this.#killNow(terminalId);
    this.#chains.clear();
  }

  status(): PiTuiStatus {
    return { terminalIds: [...this.#live.keys()] };
  }

  #reserveCapacity(): void {
    if (this.#live.size < this.#maxLiveTerminals) return;
    const suspended = [...this.#live.values()]
      .filter((terminal) => terminal.suspended)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!suspended) {
      throw new Error(`Pi TUI capacity reached (${this.#maxLiveTerminals})`);
    }
    // Eviction cannot wait — it runs inside an open that has to answer now. The
    // terminal it takes is a parked one whose chat is not the one being opened,
    // and the GUI re-reads that chat's file before it writes it again
    // (`tuiWrittenSessions` in ipc/piTui.ts), so a late exit here costs a stale
    // timeline rather than a second writer.
    this.#killNow(suspended.terminalId);
  }

  /** Unbook a terminal and signal it, without waiting. */
  #killNow(terminalId: string): void {
    const live = this.#live.get(terminalId);
    if (!live) return;
    this.#live.delete(terminalId);
    this.#killOnce(live);
    this.#emitState(terminalId, 'dead');
  }

  /**
   * terminal-01 — the disposal that the handover depends on: signal, wait for
   * the exit event, escalate once, and say plainly when the process still has
   * not been seen to go.
   */
  async #disposeAndConfirm(terminalId: string): Promise<boolean> {
    const live = this.#live.get(terminalId);
    if (!live) return true;
    this.#live.delete(terminalId);
    this.#emitState(terminalId, 'dead');
    if (live.exited) return true;
    this.#killOnce(live);
    if (await this.#waitForExit(live, this.#exitConfirmMs)) return true;
    try {
      this.#forceKill(live.pty);
    } catch (error) {
      console.warn(`[pi-tui] Force kill failed for terminal ${terminalId}:`, error);
    }
    if (await this.#waitForExit(live, this.#forceConfirmMs)) return true;
    console.warn(
      `[pi-tui] Terminal ${terminalId} never reported its exit; treating its chat as still contested`
    );
    return false;
  }

  #killOnce(live: LiveTerminal): void {
    try {
      live.pty.kill();
    } catch (error) {
      // Not "it may already have exited": node-pty swallows that case itself on
      // unix, so an error arriving here is a kill that did not happen.
      console.warn(`[pi-tui] Kill failed for terminal ${live.terminalId}:`, error);
    }
  }

  #waitForExit(live: LiveTerminal, timeoutMs: number): Promise<boolean> {
    if (live.exited) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        clearTimeout(timer);
        live.exitWaiters.delete(waiter);
        resolve(true);
      };
      timer = setTimeout(() => {
        live.exitWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      live.exitWaiters.add(waiter);
    });
  }

  /**
   * D17 — leave the PTY at a size the child does NOT have, so the renderer's
   * own resize (sent once its new xterm is attached) becomes a real change the
   * child repaints on.
   *
   * The first attempt at this nudged the size off and straight back inside this
   * one call, and the point check found it changed nothing on the real machine:
   * the screen was still blank and only 10 bytes came back, while a manual
   * `piTui.resize(id, 70, 20)` restored it instantly. Both ioctls run in the
   * same synchronous turn, so the child is scheduled once, after both — and
   * standard signals do not queue, so what it sees is one SIGWINCH and a
   * winsize identical to the one it already had. A TTY only raises SIGWINCH
   * when the size actually CHANGES (Linux `tty_do_resize` compares the old
   * winsize first), and a child that re-reads the same numbers has nothing to
   * relayout. Net change zero is indistinguishable from no change at all.
   *
   * So the change is left standing instead. The size the child reads here
   * really is different from the one it was parked at, and it stays different
   * until the renderer sends the true size back — a separate IPC message, hence
   * a later turn, with the child scheduled in between. That makes TWO real
   * transitions the child can observe (parked → primed, primed → true) instead
   * of zero, and the second one is caused by the renderer having finished
   * attaching, so the full frame it triggers cannot land in an xterm that is
   * not listening yet. `useXterm.ts` owns that half.
   *
   * One row SHORTER rather than taller: the frame pi paints while primed then
   * fits inside the new xterm instead of scrolling its top line away. At the
   * floor (`boundedDimension`'s minimum of 5) subtracting would be clamped back
   * to the same number — which is exactly the no-op this fix is about — so that
   * case goes up instead.
   *
   * Still `resize` rather than signalling SIGWINCH ourselves: that needs a real
   * pid in production code (engineering standard appendix B1 keeps signals
   * behind an injectable seam for exactly this reason) and has no Windows
   * equivalent, whereas `resize` is node-pty's own cross-platform API.
   */
  #primeRepaint(pty: PtyHandle, cols: number | undefined, rows: number | undefined): void {
    const targetCols = boundedDimension(cols, 20, 80);
    const targetRows = boundedDimension(rows, 5, 24);
    const primedRows = targetRows > REPAINT_MIN_ROWS ? targetRows - 1 : targetRows + 1;
    this.#resizeNow(pty, targetCols, primedRows);
  }

  #resizeNow(pty: PtyHandle, cols: number | undefined, rows: number | undefined): void {
    try {
      pty.resize(boundedDimension(cols, 20, 80), boundedDimension(rows, 5, 24));
    } catch {
      // Resize races with process exit are harmless.
    }
  }

  #emitState(terminalId: string, state: PiTuiStatusEvent['state']): void {
    this.#callbacks.onState?.({ terminalId, state });
  }

  #enqueue<T>(terminalId: string, operation: () => T | Promise<T>): Promise<T> {
    if (!terminalId.trim()) return Promise.reject(new Error('terminalId is required'));
    const previous = this.#chains.get(terminalId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#chains.set(terminalId, tail);
    void tail.finally(() => {
      if (this.#chains.get(terminalId) === tail) this.#chains.delete(terminalId);
    });
    return result;
  }
}
