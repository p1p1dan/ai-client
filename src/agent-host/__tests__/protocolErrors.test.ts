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
