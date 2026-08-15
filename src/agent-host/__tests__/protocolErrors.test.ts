import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';

/**
 * Behavior-lock: spawns the real Host entry (src/agent-host/index.ts) as a child
 * process and speaks NDJSON over stdin/stdout, asserting the protocol-parse error
 * paths ahead of the C-08 refactor. Only exercises surface that does NOT reach
 * ensureRuntime() (no settings/cometix/SDK loading), so it stays hermetic.
 */

const TEST_TIMEOUT = 15000;
const NEXT_EVENT_TIMEOUT = 5000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const HOST_ENTRY = path.resolve(__dirname, '..', 'index.ts');

interface HostEvent {
  type: string;
  seq: number;
  timestamp: number;
  requestId?: string;
  payload?: Record<string, unknown>;
}

interface Waiter {
  resolve: (event: HostEvent) => void;
  reject: (err: Error) => void;
}

/** Thin NDJSON request/response harness around the spawned Host process. */
class HostHarness {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: HostEvent[] = [];
  private waiters: Waiter[] = [];
  private exitInfo: { code: number | null } | null = null;
  private exitWaiters: Array<(info: { code: number | null }) => void> = [];

  constructor() {
    this.child = spawn(process.execPath, ['--experimental-strip-types', HOST_ENTRY], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        // The protocol only ever puts NDJSON on stdout; a bad line here would be a
        // Host bug, not something these tests are meant to assert on directly.
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(event);
      else this.queue.push(event);
    });

    // Host logs (startup banner + Node's ExperimentalWarning) land on stderr —
    // ignored entirely per the brief; just drain it so the pipe never backs up.
    this.child.stderr.resume();

    this.child.on('exit', (code) => {
      this.exitInfo = { code };
      for (const resolve of this.exitWaiters) resolve({ code });
      this.exitWaiters = [];
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) {
        waiter.reject(
          new Error(`host process exited (code=${String(code)}) before emitting event`)
        );
      }
    });
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  nextEvent(timeoutMs = NEXT_EVENT_TIMEOUT): Promise<HostEvent> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() as HostEvent);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a host stdout event`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForExit(timeoutMs = NEXT_EVENT_TIMEOUT): Promise<{ code: number | null }> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for host exit`));
      }, timeoutMs);
      this.exitWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  kill(): void {
    if (this.exitInfo === null && !this.child.killed) {
      this.child.kill();
    }
  }
}

describe('agent-host protocol error paths (spawned process)', () => {
  let harness: HostHarness;

  beforeEach(() => {
    harness = new HostHarness();
  });

  afterEach(() => {
    harness.kill();
  });

  it(
    'emits host.error parse_error (fatal:false) for a line of invalid JSON',
    async () => {
      harness.sendRaw('not json{');
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.payload?.code).toBe('parse_error');
      expect(event.payload?.fatal).toBe(false);
      expect(typeof event.payload?.message).toBe('string');
    },
    TEST_TIMEOUT
  );

  it(
    'emits host.error invalid_command for JSON non-object lines (number/string/null)',
    async () => {
      for (const raw of ['42', '"str"', 'null']) {
        harness.sendRaw(raw);
        const event = await harness.nextEvent();
        expect(event.type).toBe('host.error');
        expect(event.payload?.code).toBe('invalid_command');
        expect(event.payload?.message).toBe('Command must be a JSON object');
      }
    },
    TEST_TIMEOUT
  );

  it(
    'emits host.error protocol_mismatch for missing/wrong protocolVersion, and for a bare JSON array',
    async () => {
      harness.send({ type: 'x' });
      let event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.payload?.code).toBe('protocol_mismatch');
      expect(event.payload?.message).toBe(
        `Expected protocolVersion ${AGENT_HOST_PROTOCOL_VERSION}, got undefined`
      );

      const wrongVersion = AGENT_HOST_PROTOCOL_VERSION + 999;
      harness.send({ type: 'x', protocolVersion: wrongVersion });
      event = await harness.nextEvent();
      expect(event.payload?.code).toBe('protocol_mismatch');
      expect(event.payload?.message).toBe(
        `Expected protocolVersion ${AGENT_HOST_PROTOCOL_VERSION}, got ${wrongVersion}`
      );

      // typeof [] === 'object' passes the raw-object guard, so a bare array falls
      // through to the same protocolVersion check (cmd.protocolVersion is undefined).
      harness.sendRaw('[]');
      event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.payload?.code).toBe('protocol_mismatch');
    },
    TEST_TIMEOUT
  );

  it(
    'emits host.error not_implemented for an unknown command type, echoing requestId',
    async () => {
      harness.send({
        type: 'totally.unknown.command',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-unknown-1',
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-unknown-1');
      expect(event.payload?.code).toBe('not_implemented');
      expect(event.payload?.message).toBe('Unknown command: totally.unknown.command');
      expect(event.payload?.fatal).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    'emits host.error invalid_payload for session.listHistory missing workspacePath (validated before runtime init)',
    async () => {
      harness.send({
        type: 'session.listHistory',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-history-1',
        payload: {},
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-history-1');
      expect(event.payload?.code).toBe('invalid_payload');
      expect(event.payload?.message).toBe('session.listHistory requires workspacePath');
      expect(event.payload?.fatal).toBe(false);
    },
    TEST_TIMEOUT
  );

  /**
   * S2 (b) BLOCKER lock. Before this, `session.create`/`session.resume` never
   * read `payload.agent` at all: a protocol-legal Codex request was handed to
   * the only runtime present and answered as Claude, with no error anywhere.
   * Resume was worse — a Codex `runtimeIdentity` (a threadId) would have gone
   * to Claude's `--resume`.
   *
   * Asserted through the SPAWNED Host, i.e. through the real command switch,
   * because the bug was in the dispatch and not in any helper: a unit test on a
   * predicate would have stayed green throughout.
   */
  it(
    'refuses session.create for an agent this build cannot run — non-fatal, before runtime init',
    async () => {
      harness.send({
        type: 'session.create',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-agent-create-1',
        payload: { sessionId: 's-codex-1', workspacePath: REPO_ROOT, agent: 'codex' },
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-agent-create-1');
      expect(event.payload?.code).toBe('agent_unsupported');
      expect(event.payload?.fatal).toBe(false);
      // Correlated to the session too, so the Composer can scope it.
      expect((event as { sessionId?: string }).sessionId).toBe('s-codex-1');
      // The message must name the offending value AND what this build has, or
      // a downgraded user gets "unsupported" with nothing to act on.
      expect(String(event.payload?.message)).toContain('codex');
      expect(String(event.payload?.message)).toContain('claude-code');
    },
    TEST_TIMEOUT
  );

  /**
   * S3 slice 5a raised the stakes on this one: `CodexRuntime.resumeSession` no
   * longer refuses on its own (it now binds the registry row and emits the
   * degradation contract), so THIS gate is the only thing between a build that
   * cannot run codex and a session bound to it. If the check were dropped, the
   * first assertion below would see `session.resumed` instead of the refusal.
   */
  it(
    'refuses session.resume for a foreign agent, and never creates the session',
    async () => {
      harness.send({
        type: 'session.resume',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-agent-resume-1',
        payload: {
          sessionId: 's-codex-2',
          workspacePath: REPO_ROOT,
          // A Codex threadId. Handing this to Claude's resume is the exact
          // silent failure the refusal exists to prevent.
          runtimeIdentity: '01998f0c-0000-7000-8000-000000000000',
          agent: 'codex',
        },
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-agent-resume-1');
      expect(event.payload?.code).toBe('agent_unsupported');
      expect(event.payload?.fatal).toBe(false);

      // Nothing was registered: a follow-up send finds no session at all —
      // proof the refusal returned before `rt.resumeSession`, and that the
      // session never entered a starting/busy state. `session.send` DOES reach
      // ensureRuntime(), so this second assertion is the one place these tests
      // leave the hermetic surface; it is worth it, because "did not create"
      // is the half a host.error assertion alone cannot show.
      harness.send({
        type: 'session.send',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-agent-resume-2',
        payload: { sessionId: 's-codex-2', text: 'hello' },
      });
      const after = await harness.nextEvent(TEST_TIMEOUT);
      expect(after.type).toBe('host.error');
      expect(after.payload?.code).toBe('session_not_found');
    },
    TEST_TIMEOUT
  );

  it(
    'accepts an absent agent (legacy default) and an explicit claude-code — neither is refused',
    async () => {
      // Only asserts that NO `agent_unsupported` comes back; both of these do
      // reach ensureRuntime() and then create for real, so the reply itself is
      // environment-dependent and is not what this locks.
      for (const [requestId, payload] of [
        ['req-agent-absent', { sessionId: 's-legacy', workspacePath: REPO_ROOT }],
        [
          'req-agent-claude',
          { sessionId: 's-claude', workspacePath: REPO_ROOT, agent: 'claude-code' },
        ],
      ] as const) {
        harness.send({
          type: 'session.create',
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId,
          payload,
        });
        const event = await harness.nextEvent(TEST_TIMEOUT);
        expect(event.payload?.code).not.toBe('agent_unsupported');
      }
    },
    TEST_TIMEOUT
  );

  it(
    'advertises the agents it will accept on host.ready (capabilities.agents)',
    async () => {
      harness.send({
        type: 'host.initialize',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-init-agents',
      });
      const event = await harness.nextEvent(TEST_TIMEOUT);
      expect(event.type).toBe('host.ready');
      const capabilities = event.payload?.capabilities as { agents?: string[] } | undefined;
      // Exact list, not a `toContain`: the renderer disables everything absent
      // from it, so an accidentally-widened list would re-enable a binding the
      // create path refuses — the two facts must stay one.
      expect(capabilities?.agents).toEqual(['claude-code']);
    },
    TEST_TIMEOUT
  );

  it(
    'ignores empty and whitespace-only lines (no stdout output for them)',
    async () => {
      harness.sendRaw('');
      harness.sendRaw('   ');
      harness.sendRaw('\t');
      harness.send({
        type: 'x',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION + 999,
        requestId: 'after-blanks',
      });
      // If a blank line had produced output, it would have been queued ahead of
      // this reply and this assertion would see the wrong requestId/code.
      const event = await harness.nextEvent();
      expect(event.requestId).toBe('after-blanks');
      expect(event.payload?.code).toBe('protocol_mismatch');
    },
    TEST_TIMEOUT
  );

  it(
    'host.shutdown replies host.ready(shuttingDown:true) then the process exits 0',
    async () => {
      harness.send({
        type: 'host.shutdown',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'shutdown-1',
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.ready');
      expect(event.requestId).toBe('shutdown-1');
      expect(event.payload?.shuttingDown).toBe(true);
      expect(event.payload?.protocolVersion).toBe(AGENT_HOST_PROTOCOL_VERSION);

      const { code } = await harness.waitForExit();
      expect(code).toBe(0);
    },
    TEST_TIMEOUT
  );
});
