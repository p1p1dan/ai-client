import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_HOST_PROTOCOL_VERSION } from '../../shared/types/agentHost.ts';
import { CODEX_FLAG_ENV, describeHostAgentReason } from '../agentSupport.ts';
import { CODEX_JS_PATH_ENV, NODE_EXEC_PATH_ENV } from '../codexNodeEntry.ts';

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

  /**
   * S3 slice 6 (C1/F13): `envOverride` layers onto the child's env on top of
   * an explicit `AICLIENT_AGENT_CODEX: ''` pin — every harness defaults to
   * the OFF position regardless of what the test RUNNER's own environment has
   * set. The flag on/off gate (spec §4) re-runs this whole suite a second
   * time with `AICLIENT_AGENT_CODEX=1` set OUTSIDE vitest, and without this
   * pin every "off" assertion in this file would silently start asserting
   * against an ON Host during that second run — that drift is exactly what
   * F13 found. A test that wants the on position passes it explicitly.
   */
  constructor(envOverride: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, ['--experimental-strip-types', HOST_ENTRY], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, [CODEX_FLAG_ENV]: '', ...envOverride },
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

  /**
   * Waits `windowMs`, then returns every event that arrived during that
   * window (queued, since nothing was pending a `nextEvent()` call to hand
   * them to instead). Used to assert a BOUNDED absence — e.g. "no
   * session.created/session.status trailed this refusal" (G1's off-runtime
   * half, O18) — as a positive collect-and-inspect, unlike `nextEvent`, which
   * treats a timeout as failure.
   */
  eventsWithin(windowMs: number): Promise<HostEvent[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.queue.splice(0, this.queue.length));
      }, windowMs);
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

/**
 * Drain until the reply to ONE request arrives. Needed by any case that has to
 * set a session up first: a `session.create` answers with several events
 * (created, then status), so `nextEvent()` alone would hand back whichever came
 * first rather than the one being asserted on.
 */
async function waitForRequest(harness: HostHarness, requestId: string): Promise<HostEvent> {
  for (let i = 0; i < 40; i += 1) {
    const event = await harness.nextEvent();
    if (event.requestId === requestId) return event;
  }
  throw new Error(`no event for requestId ${requestId}`);
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
      // Pinned to the flag_off REASON specifically, not merely "unavailable":
      // in an environment where AICLIENT_CODEX_HOME happens to be unset too
      // (true for every plain `vitest run`, since only Main injects it),
      // codex ends up unavailable via home_prepare_failed regardless of the
      // flag position, which would leave the two assertions above green even
      // if the harness's off-pin (constructor doc above) were silently
      // dropped. This is the assertion the on/off gate actually needs.
      expect(String(event.payload?.message)).toContain(describeHostAgentReason('flag_off'));

      // G1 (off runtime half, O18): the refusal must be a dead end — no
      // session.created/session.status trails it within a bounded window,
      // proving no session/busy state was created before the refusal fired.
      const trailing = await harness.eventsWithin(300);
      expect(trailing.map((e) => e.type)).not.toContain('session.created');
      expect(trailing.map((e) => e.type)).not.toContain('session.status');
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

  /**
   * D48 S3 §5.3 (N1) — the capability key the TYPE has carried since S2 while no
   * Host ever set it. Every shipped renderer already reads absent as "old Host,
   * keep the permissionMode-only behaviour", so this key is what buys the read
   * side its degradation signal back.
   */
  it(
    'advertises permissionPolicy on host.ready (C7, Host arm)',
    async () => {
      harness.send({
        type: 'host.initialize',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-init-permission-policy',
      });
      const event = await harness.nextEvent(TEST_TIMEOUT);
      expect(event.type).toBe('host.ready');
      const capabilities = event.payload?.capabilities as
        | { permissionPolicy?: unknown; agents?: string[] }
        | undefined;
      expect(capabilities?.permissionPolicy).toBe(true);
      // Same object as the agents list: a build that emitted one and forgot the
      // other would leave the surface unable to tell which half it may trust.
      expect(capabilities?.agents).toEqual(['claude-code']);
    },
    TEST_TIMEOUT
  );

  /**
   * D48 S3 §5.7-C10 — the posture and the agent are ONE decision.
   *
   * All three arms below are refused BEFORE any runtime is built, which is what
   * makes them assertable here at all (this suite never loads the SDK): the
   * check sits between `resolveAgentWireName` and `runtimeForAgent`. Dropping
   * instead of refusing would be the silent failure — a caller that asked for
   * `plan` and was quietly given `default` believes it constrained a session
   * that is not constrained.
   */
  it(
    'C10 — refuses a permissionPreference addressed to the other agent, on create and on resume',
    async () => {
      for (const [requestId, type, extra] of [
        ['req-pref-create-cross', 'session.create', {}],
        ['req-pref-resume-cross', 'session.resume', { runtimeIdentity: 'claude-session-id' }],
      ] as const) {
        harness.send({
          type,
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId,
          payload: {
            sessionId: 's-pref-cross',
            workspacePath: REPO_ROOT,
            // Absent `agent` = Claude Code (the legacy default), so a Codex
            // posture here is the mismatch.
            permissionPreference: {
              agent: 'codex',
              approvalPolicy: 'never',
              sandboxMode: 'danger-full-access',
            },
            ...extra,
          },
        });
        const event = await harness.nextEvent(TEST_TIMEOUT);
        expect(event.type).toBe('host.error');
        expect(event.requestId).toBe(requestId);
        expect(event.payload?.code).toBe('invalid_payload');
        expect(event.payload?.fatal).toBe(false);
        // A dead end, like the agent refusal above: nothing was created, so no
        // session/busy state trails it.
        const trailing = await harness.eventsWithin(300);
        expect(trailing.map((e) => e.type)).not.toContain('session.created');
        expect(trailing.map((e) => e.type)).not.toContain('session.resumed');
      }
    },
    TEST_TIMEOUT * 2
  );

  it(
    'C8/C10 — refuses a forged networkAccess and a malformed tier rather than trimming them',
    async () => {
      for (const [requestId, permissionPreference] of [
        [
          'req-pref-network',
          {
            agent: 'codex',
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
            networkAccess: true,
          },
        ],
        ['req-pref-garbage', { agent: 'claude-code', permissionMode: 'yolo' }],
        ['req-pref-shape', 'bypassPermissions'],
      ] as const) {
        harness.send({
          type: 'session.create',
          protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
          requestId,
          payload: {
            sessionId: 's-pref-bad',
            workspacePath: REPO_ROOT,
            permissionPreference,
          },
        });
        const event = await harness.nextEvent(TEST_TIMEOUT);
        expect(event.type).toBe('host.error');
        expect(event.requestId).toBe(requestId);
        // `networkAccess` is a fact the runtime reports, never a request field:
        // accepting the object (even by ignoring that one key) would let the
        // caller believe a dimension was configured that nothing configured.
        expect(event.payload?.code).toBe('invalid_payload');
      }
    },
    TEST_TIMEOUT * 2
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
    'D48 S4 — session.updatePermission refuses a session it has no binding for',
    async () => {
      // Hermetic on purpose: both refusals below return BEFORE `runtimeForAgent`
      // is reached, so no runtime is built and no SDK is loaded. That is also
      // the property being asserted — a posture change for a session this Host
      // never registered must not fall back to "probably Claude" the way
      // send/stop/close do, because there is no safe guess about a posture.
      harness.send({
        type: 'session.updatePermission',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-perm-ghost',
        payload: {
          sessionId: 'never-created',
          permissionPreference: { agent: 'claude-code', permissionMode: 'plan' },
        },
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-perm-ghost');
      expect(event.payload?.code).toBe('session_not_found');
      expect(event.payload?.fatal).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    'D48 S4 — a session.updatePermission with no sessionId is an invalid payload',
    async () => {
      harness.send({
        type: 'session.updatePermission',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-perm-empty',
        payload: { permissionPreference: { agent: 'claude-code', permissionMode: 'plan' } },
      });
      const event = await harness.nextEvent();
      expect(event.type).toBe('host.error');
      expect(event.requestId).toBe('req-perm-empty');
      expect(event.payload?.code).toBe('invalid_payload');
    },
    TEST_TIMEOUT
  );

  it(
    'D48 S4 — `permissionPreference: null` is caught by the REQUIRED guard, not two layers down',
    async () => {
      // `readPermissionPreference` reads `null` as "nothing was asked for" and
      // answers `{ok:true}` with no preference. So a `null` that slipped past the
      // REQUIRED guard would reach `permissionChangeNeedsConfirmation(undefined,
      // …)` — vacuously false, i.e. the dangerous-tier wall spinning on nothing —
      // and only be stopped later by a different error with a different message.
      // Hermetic: `createSession` registers the row without loading the SDK
      // (`ensureSdk` runs on the first send, which this test never does).
      harness.send({
        type: 'session.create',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-perm-null-create',
        payload: { sessionId: 's-perm-null', workspacePath: REPO_ROOT },
      });
      await waitForRequest(harness, 'req-perm-null-create');

      harness.send({
        type: 'session.updatePermission',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-perm-null',
        payload: { sessionId: 's-perm-null', permissionPreference: null },
      });
      const event = await waitForRequest(harness, 'req-perm-null');
      expect(event.type).toBe('host.error');
      expect(event.payload?.code).toBe('invalid_payload');
      // The message identifies WHICH guard refused it: a change command with
      // nothing to change is the caller's bug, and saying so is the whole point
      // of having the guard rather than letting the runtime answer differently.
      expect(String(event.payload?.message)).toContain('requires permissionPreference');
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

/**
 * S3 slice 6 施工 C — flag on/off gate, non-hermetic-test retrofit (spec §4).
 * The suite above always runs OFF now (`HostHarness`'s default env pin), so
 * every arm that needs the ON position lives here instead, each owning its
 * own harness(es) and its own throwaway fixture directory rather than the
 * single shared harness above — spawn is slow, so the new arm count is kept
 * to exactly what G1/G17 ask for (one harness lifecycle per arm).
 */
describe('agent-host flag on/off gate — protocolErrors non-hermetic retrofit (S3 slice 6 C)', () => {
  let tmpRoot: string;
  let harnesses: HostHarness[];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiclient-codex-gate-'));
    harnesses = [];
  });

  afterEach(() => {
    for (const h of harnesses) h.kill();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function spawnHarness(envOverride: NodeJS.ProcessEnv = {}): HostHarness {
    const harness = new HostHarness(envOverride);
    harnesses.push(harness);
    return harness;
  }

  it(
    'on-arm: registry advertises codex when a fabricated entry and home both resolve',
    async () => {
      // Positive arm of G1's four: flag on, entry resolves, home prepares.
      // Fabricated end to end so it is true on a CI box with no codex install
      // exactly the same way it is true on this dev machine.
      const entryDir = path.join(tmpRoot, 'fake-codex-entry');
      mkdirSync(entryDir, { recursive: true });
      const entryPath = path.join(entryDir, 'codex.js');
      // Never executed: host.initialize only PROBES existence
      // (resolveCodexLaunch) and prepares the isolated home; it does not spawn.
      writeFileSync(entryPath, '// fixture codex.js entry, existence-only\n');

      const harness = spawnHarness({
        [CODEX_FLAG_ENV]: '1',
        // Candidate #1 in resolveCodexLaunch's search order (codexNodeEntry.ts)
        // — checked before path_shim/node_sibling/path_node_sibling.
        [CODEX_JS_PATH_ENV]: entryPath,
        // The other three candidates are ALSO starved (same recipe as the
        // negative arm below), not left to inherit this process's real PATH —
        // otherwise, on a machine with a real codex install (this dev box
        // [实测] has one), entry resolution could succeed via node_sibling/
        // path_shim even with entryPath above deleted, and this test would
        // stay green for the wrong reason instead of because of the fixture.
        [NODE_EXEC_PATH_ENV]: path.join(tmpRoot, 'no-such-node-root', 'bin', 'node'),
        PATH: '',
        // Destination: ensureCodexHome (codexHome.ts) mkdir -p's this and
        // writes config.toml into it. index.ts's own (unexported)
        // CODEX_HOME_ENV constant — mirrored here as a literal because this
        // file may only touch protocolErrors.test.ts.
        AICLIENT_CODEX_HOME: path.join(tmpRoot, 'codex-home'),
        // codex's OWN env var, read by resolveSourceCodexHome (codexHome.ts)
        // ahead of homedir() — redirects the SOURCE projection away from the
        // real ~/.codex. A nonexistent source is tolerated (missing
        // config.toml/auth.json are logged, not thrown), so this never reads
        // or copies a real user credential.
        CODEX_HOME: path.join(tmpRoot, 'codex-home-source-absent'),
      });

      harness.send({
        type: 'host.initialize',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-init-on',
      });
      const event = await harness.nextEvent(TEST_TIMEOUT);
      expect(event.type).toBe('host.ready');
      const capabilities = event.payload?.capabilities as { agents?: string[] } | undefined;
      expect(capabilities?.agents).toEqual(['claude-code', 'codex']);
    },
    TEST_TIMEOUT
  );

  it(
    'on-arm: refuses session.create for codex when NO candidate entry resolves — never really spawns',
    async () => {
      // Negative arm of G1's four: flag on, entry_missing. Every candidate
      // resolveCodexLaunch (codexNodeEntry.ts) can produce is starved, so
      // this is true on a CI box with no codex install exactly the same way
      // it is true on this dev machine (which, per that module's own header,
      // [实测] has a real codex install sitting right next to its real node
      // binary):
      //   1. env override      → points at a codex.js that is never written
      //   2. path_shim         → PATH is empty, findOnPath sees zero dirs
      //   3. node_sibling      → AICLIENT_NODE_EXEC_PATH points under a tmp
      //      root with no lib/node_modules/@openai/codex/bin/codex.js,
      //      instead of the real node binary that launched this Host
      //   4. path_node_sibling → covered by the same empty PATH as (2)
      const harness = spawnHarness({
        [CODEX_FLAG_ENV]: '1',
        [CODEX_JS_PATH_ENV]: path.join(tmpRoot, 'nowhere', 'codex.js'),
        [NODE_EXEC_PATH_ENV]: path.join(tmpRoot, 'no-such-node-root', 'bin', 'node'),
        PATH: '',
      });

      harness.send({
        type: 'session.create',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-on-entry-missing',
        payload: { sessionId: 's-codex-on-missing', workspacePath: REPO_ROOT, agent: 'codex' },
      });
      const event = await harness.nextEvent(TEST_TIMEOUT);
      expect(event.type).toBe('host.error');
      expect(event.payload?.code).toBe('agent_unsupported');
      expect((event as { sessionId?: string }).sessionId).toBe('s-codex-on-missing');
      // The entry-specific clue, proving the refusal knows WHICH gate stopped
      // it (S3 slice 6 spec §2 point 7), not just THAT one did.
      expect(String(event.payload?.message)).toContain(describeHostAgentReason('entry_missing'));

      // rejectUnsupportedAgent returns before ensureCodexRuntime/CodexRuntime
      // ever construct, so a spawn of the (nonexistent) entry is structurally
      // impossible here — this bounded window corroborates nothing trails.
      const trailing = await harness.eventsWithin(300);
      expect(trailing).toEqual([]);
    },
    TEST_TIMEOUT
  );

  it(
    'Claude create is unaffected by the codex flag position: off/on arms emit the same first session.created',
    async () => {
      // C5/G17: "not agent_unsupported" alone cannot carry "Claude is
      // unaffected" — this asserts the actual event both arms produce is the
      // same, field by field (minus seq/timestamp, which are per-process).
      const claudePayload = {
        sessionId: 's-claude-equiv',
        workspacePath: REPO_ROOT,
        agent: 'claude-code',
      };

      const offHarness = spawnHarness();
      offHarness.send({
        type: 'session.create',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-claude-equiv',
        payload: claudePayload,
      });
      const offEvent = await offHarness.nextEvent(TEST_TIMEOUT);

      // Flag ON, same entry-starved recipe as the negative arm above:
      // irrelevant to a claude-code create's OUTCOME, but rejectUnsupportedAgent
      // builds the registry for any NAMED agent (not only 'codex'), so this
      // keeps that build deterministic (entry_missing specifically, not a
      // machine-dependent mix of entry_missing/home_prepare_failed) rather
      // than depending on whether this box happens to have a real codex
      // install. Starving PATH here is safe: Claude's own bootstrap
      // (ensureRuntime → loadClaudeSettingsEnv/resolveCometixCli) resolves
      // its cli.js via node module resolution (cometix.ts), never PATH.
      const onHarness = spawnHarness({
        [CODEX_FLAG_ENV]: '1',
        [CODEX_JS_PATH_ENV]: path.join(tmpRoot, 'equiv-nowhere', 'codex.js'),
        [NODE_EXEC_PATH_ENV]: path.join(tmpRoot, 'equiv-no-node-root', 'bin', 'node'),
        PATH: '',
      });
      onHarness.send({
        type: 'session.create',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        requestId: 'req-claude-equiv',
        payload: claudePayload,
      });
      const onEvent = await onHarness.nextEvent(TEST_TIMEOUT);

      expect(offEvent.type).toBe('session.created');
      expect(onEvent.type).toBe('session.created');
      // The only two fields a brand-new Claude session.created carries
      // (claudeRuntime.ts:334-342) — both fixed constants (agent's own name,
      // CHAT_PERMISSION_MODE), so a fresh runtime per harness still produces
      // byte-identical payloads.
      expect(onEvent.payload).toEqual(offEvent.payload);
      expect(offEvent.requestId).toBe('req-claude-equiv');
      expect(onEvent.requestId).toBe('req-claude-equiv');
      expect((offEvent as { sessionId?: string }).sessionId).toBe('s-claude-equiv');
      expect((onEvent as { sessionId?: string }).sessionId).toBe('s-claude-equiv');
    },
    TEST_TIMEOUT * 2
  );
});
