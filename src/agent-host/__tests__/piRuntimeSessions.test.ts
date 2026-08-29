import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import { PiAgentRuntime } from '../piRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';
import {
  type CapturedEvent,
  createPiSdkStub,
  type PiSdkStubOptions,
} from './fixtures/piSdkStub.ts';

/**
 * Pi runtime — session isolation, the permission gate, Stop, and the wire
 * contract.
 *
 * The organising fact: this app is a WORKTREE manager, so "two sessions" is the
 * normal case and "two sessions in two different checkouts" is the normal case
 * for the normal case. Every test below is a way for two sessions to contaminate
 * each other, or for one session to run tools with nothing gating them.
 */

const GATED: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

function harness(options: PiSdkStubOptions = {}, gate: PermissionPluginDecision = GATED) {
  const events: CapturedEvent[] = [];
  const stub = createPiSdkStub(options);
  const registry = new SessionRegistry();
  const runtime = new PiAgentRuntime({
    registry,
    emit: (event) => events.push(event as CapturedEvent),
    log: () => undefined,
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => gate,
  });
  return { events, stub, registry, runtime };
}

function eventsOfType(events: CapturedEvent[], type: string): CapturedEvent[] {
  return events.filter((event) => event.type === type);
}

// ─── P0-2: multi-session / multi-worktree isolation ───

describe('PiAgentRuntime session isolation', () => {
  it('builds one runtime per workspace when two sessions are used in turn', async () => {
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });

    await h.runtime.send({ sessionId: 'a', text: 'hello A' });
    await h.runtime.send({ sessionId: 'b', text: 'hello B' });

    // The bug this replaces: the second send reused the first handle, so
    // `/repo-b`'s tools ran in `/repo-a`.
    expect(h.stub.sessions).toHaveLength(2);
    expect(h.stub.sessionFor('/repo-a')?.prompts.map((p) => p.text)).toEqual(['hello A']);
    expect(h.stub.sessionFor('/repo-b')?.prompts.map((p) => p.text)).toEqual(['hello B']);
  });

  it('reuses one runtime across turns of the same session', async () => {
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'one' });
    await h.runtime.send({ sessionId: 'a', text: 'two' });

    expect(h.stub.sessions).toHaveLength(1);
    expect(h.stub.sessionFor('/repo-a')?.prompts.map((p) => p.text)).toEqual(['one', 'two']);
  });

  it('keeps two concurrent sends on their own sessions', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });

    const sendA = h.runtime.send({ sessionId: 'a', text: 'A' });
    const sendB = h.runtime.send({ sessionId: 'b', text: 'B' });
    await vi.waitFor(() => expect(h.stub.sessions).toHaveLength(2));

    // Events raised by A's pi session must carry A's sessionId, not B's.
    h.stub.sessionFor('/repo-a')?.emit({
      type: 'tool_execution_start',
      toolCallId: 't-a',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    h.stub.sessionFor('/repo-b')?.emit({
      type: 'tool_execution_start',
      toolCallId: 't-b',
      toolName: 'read',
      args: { path: '/x' },
    });

    const started = eventsOfType(h.events, 'tool.started');
    expect(started.map((e) => [e.sessionId, e.payload?.toolCallId])).toEqual([
      ['a', 't-a'],
      ['b', 't-b'],
    ]);

    h.stub.finishPrompt('/repo-a');
    h.stub.finishPrompt('/repo-b');
    await Promise.all([sendA, sendB]);
  });

  it('stops only the session it was asked to stop', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });
    const sendA = h.runtime.send({ sessionId: 'a', text: 'A' });
    const sendB = h.runtime.send({ sessionId: 'b', text: 'B' });
    await vi.waitFor(() => expect(h.stub.sessions).toHaveLength(2));

    h.runtime.stop('a');

    expect(h.stub.sessionFor('/repo-a')?.aborted).toBe(true);
    expect(h.stub.sessionFor('/repo-b')?.aborted).toBe(false);
    await sendA;
    h.stub.finishPrompt('/repo-b');
    await sendB;
  });

  it('leaves the other session running when one is closed', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });
    const sendA = h.runtime.send({ sessionId: 'a', text: 'A' });
    const sendB = h.runtime.send({ sessionId: 'b', text: 'B' });
    await vi.waitFor(() => expect(h.stub.sessions).toHaveLength(2));

    h.runtime.closeSession('a');
    expect(h.runtime.activeSessionCount()).toBe(1);

    // B is still wired: its pi events still project onto B.
    h.stub.sessionFor('/repo-b')?.emit({ type: 'agent_settled' });
    expect(eventsOfType(h.events, 'session.completed').map((e) => e.sessionId)).toEqual(['b']);

    await sendA;
    h.stub.finishPrompt('/repo-b');
    await sendB;
  });

  it('rebuilds the runtime when a session moves to another workspace', async () => {
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'first' });

    // A resume can legitimately point the same sessionId at a different
    // checkout; carrying the old handle over would run its tools in the old one.
    h.runtime.resumeSession({
      sessionId: 'a',
      workspacePath: '/repo-moved',
      runtimeIdentity: '/repo-a/session.jsonl',
    });
    await h.runtime.send({ sessionId: 'a', text: 'second' });

    expect(h.stub.sessionFor('/repo-moved')?.prompts.map((p) => p.text)).toEqual(['second']);
    expect(h.stub.sessionFor('/repo-a')?.prompts.map((p) => p.text)).toEqual(['first']);
  });
});

// ─── P0-1: fail-closed permission gate ───

describe('PiAgentRuntime permission gate', () => {
  const ungated: PermissionPluginDecision = {
    additionalExtensionPaths: [],
    reason: 'missing',
    gated: false,
    detail: 'no bundled plugin directory at /nowhere',
  };

  it('refuses to run a turn when no permission plugin is available', async () => {
    const h = harness({}, ungated);
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'run something' });

    // The tool call never gets the chance to happen: no pi session was created.
    expect(h.stub.sessions).toHaveLength(0);
    const fatal = eventsOfType(h.events, 'host.error').at(-1);
    expect(fatal?.payload).toMatchObject({ code: 'permission_plugin_missing', fatal: true });
    expect(String(fatal?.payload?.message)).toContain('/nowhere');
    expect(eventsOfType(h.events, 'session.failed')).toHaveLength(1);
  });

  it('refuses when the plugin loaded but the approval UI cannot be bound', async () => {
    const h = harness({ noBindExtensions: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'run something' });

    expect(h.stub.sessionFor('/repo-a')?.prompts).toEqual([]);
    expect(eventsOfType(h.events, 'host.error').at(-1)?.payload).toMatchObject({
      code: 'extension_bind_unsupported',
      fatal: true,
    });
  });

  it('refuses when binding the approval UI throws', async () => {
    const h = harness({ bindThrows: 'ui context rejected' });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'run something' });

    const fatal = eventsOfType(h.events, 'host.error').at(-1);
    expect(fatal?.payload).toMatchObject({ code: 'extension_bind_failed', fatal: true });
    expect(String(fatal?.payload?.message)).toContain('ui context rejected');
  });

  it('refuses when the permission extension failed to load', async () => {
    const h = harness({
      loadedExtensions: {
        extensions: [],
        errors: [{ path: '/bundle/pi-permission-system/src/index.ts', error: 'boom' }],
      },
    });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'run something' });

    expect(h.stub.sessionFor('/repo-a')?.prompts ?? []).toEqual([]);
    expect(eventsOfType(h.events, 'host.error').at(-1)?.payload).toMatchObject({
      code: 'permission_plugin_load_failed',
      fatal: true,
    });
  });

  it('refuses when nothing that looks like a permission extension is loaded', async () => {
    const h = harness({ loadedExtensions: { extensions: [{ path: '/other/thing.ts' }] } });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'run something' });

    expect(eventsOfType(h.events, 'host.error').at(-1)?.payload).toMatchObject({
      code: 'permission_plugin_load_failed',
      fatal: true,
    });
  });

  it('runs normally, and injects the bundle, when the gate is intact', async () => {
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'hi' });

    expect(h.stub.injectedPaths).toEqual([['/bundle/pi-permission-system']]);
    expect(h.stub.sessionFor('/repo-a')?.prompts.map((p) => p.text)).toEqual(['hi']);
    expect(eventsOfType(h.events, 'host.error')).toHaveLength(0);
  });

  it('skips injection when the user config is confirmed to load the plugin', async () => {
    const h = harness({}, { additionalExtensionPaths: [], reason: 'user_configured', gated: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'hi' });

    expect(h.stub.injectedPaths).toEqual([[]]);
    expect(eventsOfType(h.events, 'host.error')).toHaveLength(0);
  });
});

// ─── T08-c: project trust follows the credential route ───

describe('PiAgentRuntime project trust (D-Q9 decision 4)', () => {
  const TRUST_ENV = 'AICLIENT_PI_TRUST_PROJECT_CONFIG';

  afterEach(() => {
    delete process.env[TRUST_ENV];
  });

  async function trustSeenBy(value: string | undefined) {
    if (value === undefined) delete process.env[TRUST_ENV];
    else process.env[TRUST_ENV] = value;
    const h = harness();
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    await h.runtime.send({ sessionId: 'a', text: 'hi' });
    return h.stub.settingsManagerCalls.at(-1)?.projectTrusted;
  }

  /**
   * The managed route promises this build works and answers for what it
   * permits, so a repository the user cloned must not be able to ship a
   * `.pi/extensions/pi-permission-system/config.json` that turns the gate off.
   */
  it('withholds a repository’s own scope on the managed route', async () => {
    await expect(trustSeenBy('0')).resolves.toBe(false);
  });

  /** The local route is the user's own machine; their checkouts are their call. */
  it('trusts a repository’s own scope on the local route', async () => {
    await expect(trustSeenBy('1')).resolves.toBe(true);
  });

  /**
   * An ABSENT key is an old Main build that predates this decision. It keeps
   * the posture that shipped before, so a version skew changes nothing rather
   * than silently tightening and breaking a working setup.
   */
  it('keeps the historical posture when Main did not send the key', async () => {
    await expect(trustSeenBy(undefined)).resolves.toBe(true);
  });

  /** A garbled value fails toward the safer side, not the historical one. */
  it('withholds the scope for any value it does not recognise', async () => {
    for (const value of ['', 'yes', 'true', '2', ' ']) {
      await expect(trustSeenBy(value)).resolves.toBe(false);
    }
  });
});

// ─── P1-3: Stop drains parked dialogs ───

describe('PiAgentRuntime stop and extension UI', () => {
  /** Reach the bridge the way an extension does, through the bound uiContext. */
  function uiContextOf(session: { boundUiContext: unknown }) {
    return session.boundUiContext as {
      select(title: string, options: string[]): Promise<string | undefined>;
    };
  }

  it('cancels the pending dialog when the user stops the turn', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'do it' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')?.boundUiContext).toBeDefined());

    const session = h.stub.sessionFor('/repo-a');
    if (!session) throw new Error('no session');
    const answer = uiContextOf(session).select('Allow bash?', ['Yes', 'No']);
    const request = eventsOfType(h.events, 'extensionUi.request').at(-1);
    expect(request?.sessionId).toBe('a');

    h.runtime.stop('a');

    // The extension's Promise settles NOW — with the dismissal fallback, which
    // for a permission prompt is a denial — rather than waiting out a timeout
    // the plugin may never have set.
    await expect(answer).resolves.toBeUndefined();
    const cancelled = eventsOfType(h.events, 'extensionUi.cancelled').at(-1);
    expect(cancelled?.sessionId).toBe('a');
    expect(cancelled?.payload).toMatchObject({
      reason: 'aborted',
      uiRequestIds: [request?.payload?.uiRequestId],
    });

    await send;
    expect(eventsOfType(h.events, 'session.status').at(-1)?.payload).toMatchObject({
      status: 'idle',
    });
  });

  it('does not touch another session’s dialogs', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });
    const sendA = h.runtime.send({ sessionId: 'a', text: 'A' });
    const sendB = h.runtime.send({ sessionId: 'b', text: 'B' });
    await vi.waitFor(() => expect(h.stub.sessions).toHaveLength(2));

    const sessionA = h.stub.sessionFor('/repo-a');
    const sessionB = h.stub.sessionFor('/repo-b');
    if (!sessionA || !sessionB) throw new Error('missing sessions');
    const answerA = uiContextOf(sessionA).select('A?', ['Yes']);
    const answerB = uiContextOf(sessionB).select('B?', ['Yes']);
    const requestB = eventsOfType(h.events, 'extensionUi.request').at(-1);

    h.runtime.stop('a');
    await expect(answerA).resolves.toBeUndefined();

    const cancelledIds = eventsOfType(h.events, 'extensionUi.cancelled').flatMap(
      (event) => (event.payload?.uiRequestIds as string[]) ?? []
    );
    expect(cancelledIds).not.toContain(requestB?.payload?.uiRequestId);

    // B's dialog is still live and still answerable.
    const runtimeId = String(requestB?.payload?.runtimeId);
    expect(
      h.runtime.respondExtensionUi({
        runtimeId,
        uiRequestId: String(requestB?.payload?.uiRequestId),
        ok: true,
        value: 'Yes',
      })
    ).toBe(true);
    await expect(answerB).resolves.toBe('Yes');

    await sendA;
    h.stub.finishPrompt('/repo-b');
    await sendB;
  });

  it('gives each session its own bridge id and refuses cross-session answers', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    h.runtime.createSession({ sessionId: 'b', workspacePath: '/repo-b' });
    const sendA = h.runtime.send({ sessionId: 'a', text: 'A' });
    const sendB = h.runtime.send({ sessionId: 'b', text: 'B' });
    await vi.waitFor(() => expect(h.stub.sessions).toHaveLength(2));

    const sessionA = h.stub.sessionFor('/repo-a');
    const sessionB = h.stub.sessionFor('/repo-b');
    if (!sessionA || !sessionB) throw new Error('missing sessions');
    void uiContextOf(sessionA).select('A?', ['Yes']);
    const answerB = uiContextOf(sessionB).select('B?', ['Yes']);
    const requests = eventsOfType(h.events, 'extensionUi.request');
    const [reqA, reqB] = [requests.at(-2), requests.at(-1)];

    expect(reqA?.payload?.runtimeId).not.toBe(reqB?.payload?.runtimeId);
    // B's id on A's bridge settles nothing.
    expect(
      h.runtime.respondExtensionUi({
        runtimeId: String(reqA?.payload?.runtimeId),
        uiRequestId: String(reqB?.payload?.uiRequestId),
        ok: true,
        value: 'Yes',
      })
    ).toBe(false);

    h.runtime.stop('a');
    h.runtime.stop('b');
    await expect(answerB).resolves.toBeUndefined();
    await Promise.all([sendA, sendB]);
  });

  it('drains dialogs when the session is closed and when the runtime is disposed', async () => {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'A' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')?.boundUiContext).toBeDefined());
    const session = h.stub.sessionFor('/repo-a');
    if (!session) throw new Error('no session');
    const answer = uiContextOf(session).select('A?', ['Yes']);

    h.runtime.closeSession('a');
    await expect(answer).resolves.toBeUndefined();
    expect(eventsOfType(h.events, 'extensionUi.cancelled').at(-1)?.payload).toMatchObject({
      reason: 'session_closed',
    });

    h.stub.finishPrompt('/repo-a');
    await send;
    await h.runtime.dispose();
    expect(h.runtime.activeSessionCount()).toBe(0);
  });
});

// ─── P1-4: wire contract ───

describe('PiAgentRuntime event contract', () => {
  async function runWith(event: Record<string, unknown>) {
    const h = harness({ manualPrompt: true });
    h.runtime.createSession({ sessionId: 'a', workspacePath: '/repo-a' });
    const send = h.runtime.send({ sessionId: 'a', text: 'go' });
    await vi.waitFor(() => expect(h.stub.sessionFor('/repo-a')).toBeDefined());
    h.stub.sessionFor('/repo-a')?.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: {},
    });
    h.stub.sessionFor('/repo-a')?.emit(event as { type: string });
    h.stub.finishPrompt('/repo-a');
    await send;
    return h;
  }

  it('reports a successful tool with ok:true and no error', async () => {
    const h = await runWith({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: 'total 0' },
    });
    const completed = eventsOfType(h.events, 'tool.completed').at(-1);
    expect(completed?.payload).toMatchObject({ toolCallId: 't1', ok: true, output: 'total 0' });
    expect(completed?.payload).not.toHaveProperty('error');
    // `isError` was pi's word; nothing on our wire reads it.
    expect(completed?.payload).not.toHaveProperty('isError');
  });

  it('reports a failed tool with ok:false and the error text', async () => {
    const h = await runWith({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: true,
      result: { content: 'permission denied' },
    });
    expect(eventsOfType(h.events, 'tool.completed').at(-1)?.payload).toMatchObject({
      ok: false,
      error: 'permission denied',
      output: 'permission denied',
    });
  });

  it('never leaves a failed tool without a reason', async () => {
    const h = await runWith({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: true,
    });
    expect(eventsOfType(h.events, 'tool.completed').at(-1)?.payload).toMatchObject({
      ok: false,
      error: 'Tool call failed',
      output: '',
    });
  });

  it('maps a retry onto the contract field names', async () => {
    const h = await runWith({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 1500,
      errorMessage: 'socket hang up',
      errorStatus: 503,
    });
    const retry = eventsOfType(h.events, 'session.status')
      .map((event) => event.payload?.retry)
      .filter(Boolean)
      .at(-1);
    expect(retry).toEqual({
      attempt: 2,
      maxRetries: 10,
      delayMs: 1500,
      error: 'socket hang up',
      errorStatus: '503',
    });
  });

  it('uses null for a transport failure with no HTTP status', async () => {
    const h = await runWith({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 10,
      delayMs: 100,
      errorMessage: 'unknown',
    });
    const retry = eventsOfType(h.events, 'session.status')
      .map((event) => event.payload?.retry)
      .filter(Boolean)
      .at(-1);
    expect(retry).toMatchObject({ error: 'unknown', errorStatus: null });
  });
});
