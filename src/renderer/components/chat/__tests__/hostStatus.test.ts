import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  describeHostStatus,
  type HostStatus,
  initialHostStatus,
  isHostUsable,
  isNode24ResolutionFailure,
  primeHostStatus,
  reduceHostStatus,
} from '../hostStatus';
import { stripComments } from './stripComments';

function event(type: string, payload?: Record<string, unknown>): RuntimeEvent {
  return {
    type,
    seq: 1,
    timestamp: 0,
    payload,
  } as unknown as RuntimeEvent;
}

describe('reduceHostStatus (T-09)', () => {
  it('absorbs host.ready into a ready snapshot with settings diagnostics', () => {
    const next = reduceHostStatus(
      initialHostStatus,
      event('host.ready', {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        nodeExecPath: '/usr/local/bin/node',
        cometixVersion: '2.1.212',
        settings: {
          loaded: true,
          hasAuthToken: true,
          hasBaseUrl: true,
          baseHost: 'gw.example',
          model: null,
        },
      })
    );
    expect(next.state).toBe('ready');
    expect(next.driver).toBe('agent-sdk');
    expect(next.nodeVersion).toBe('v24.0.0');
    expect(next.cometixVersion).toBe('2.1.212');
    expect(next.settings).toEqual({
      loaded: true,
      hasAuthToken: true,
      hasBaseUrl: true,
      baseHost: 'gw.example',
      model: null,
    });
    expect(next.lastFatalError).toBeNull();
  });

  it('marks host.ready with shuttingDown as stopped', () => {
    const next = reduceHostStatus(initialHostStatus, event('host.ready', { shuttingDown: true }));
    expect(next.state).toBe('stopped');
  });

  it('flips state to error and records message on fatal host.error', () => {
    const ready = reduceHostStatus(initialHostStatus, event('host.ready', {}));
    const next = reduceHostStatus(
      ready,
      event('host.error', { code: 'x', message: 'boom', fatal: true })
    );
    expect(next.state).toBe('error');
    expect(next.lastFatalError).toBe('boom');
  });

  it('ignores non-fatal host.error (surface elsewhere, do not mask readiness)', () => {
    const ready = reduceHostStatus(initialHostStatus, event('host.ready', {}));
    const next = reduceHostStatus(
      ready,
      event('host.error', { code: 'session_busy', message: 'busy' })
    );
    expect(next).toBe(ready);
  });

  it('keeps previous settings when host.ready carries none', () => {
    const first = reduceHostStatus(initialHostStatus, event('host.ready', { settings: null }));
    const next = reduceHostStatus(first, event('host.error', { message: 'fatal', fatal: true }));
    expect(next.state).toBe('error');
    expect(next.lastFatalError).toBe('fatal');
  });

  it('isNode24ResolutionFailure matches the resolver error wording', () => {
    expect(
      isNode24ResolutionFailure({
        state: 'error',
        lastFatalError: 'No Node 24 runtime found. Set AICLIENT_NODE24_PATH or install Node 24.',
      })
    ).toBe(true);
    expect(isNode24ResolutionFailure({ state: 'error', lastFatalError: 'boom' })).toBe(false);
    expect(isNode24ResolutionFailure({ state: 'ready', lastFatalError: null })).toBe(false);
  });

  it('ignores unrelated event types', () => {
    const ready = reduceHostStatus(initialHostStatus, event('host.ready', {}));
    expect(reduceHostStatus(ready, event('session.created'))).toBe(ready);
    expect(reduceHostStatus(ready, event('message.delta', { messageId: 'x' }))).toBe(ready);
  });

  describe('capabilities fold (T-04)', () => {
    it('records capabilities.thinking=true when host.ready advertises it', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { thinking: true } })
      );
      expect(next.capabilities).toEqual({ thinking: true });
    });

    it('records capabilities.thinking=false when Host explicitly disables thinking', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { thinking: false } })
      );
      expect(next.capabilities).toEqual({ thinking: false });
    });

    it('leaves thinking undefined when capabilities exists but flag is absent (default on)', () => {
      const next = reduceHostStatus(initialHostStatus, event('host.ready', { capabilities: {} }));
      expect(next.capabilities).toEqual({ thinking: undefined });
    });

    it('preserves prior capabilities when host.ready carries none (Host restart without flag)', () => {
      const prior = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { thinking: true } })
      );
      const next = reduceHostStatus(prior, event('host.ready', {}));
      expect(next.capabilities).toEqual({ thinking: true });
    });
  });
});

describe('primeHostStatus (S7, round-2 iteration-3 review)', () => {
  it('copies settings from the Main-side snapshot onto a placeholder state', () => {
    const next = primeHostStatus(initialHostStatus, {
      state: 'ready',
      driver: 'agent-sdk',
      cometixVersion: '2.1.212',
      settings: {
        loaded: true,
        hasAuthToken: true,
        hasBaseUrl: false,
        baseHost: null,
        model: 'opus',
      },
    });
    expect(next.state).toBe('ready');
    expect(next.driver).toBe('agent-sdk');
    expect(next.settings).toEqual({
      loaded: true,
      hasAuthToken: true,
      hasBaseUrl: false,
      baseHost: null,
      model: 'opus',
    });
  });

  it('adopts an explicit null settings snapshot (Host confirmed no diagnostics) rather than keeping a stale prior value', () => {
    const prev = {
      ...initialHostStatus,
      settings: {
        loaded: false,
        hasAuthToken: false,
        hasBaseUrl: false,
        baseHost: null,
        model: null,
      },
    };
    const next = primeHostStatus(prev, { state: 'ready', settings: null });
    expect(next.settings).toBeNull();
  });

  it('preserves the prior settings when the snapshot itself is missing (a failed/unresolved getHostStatus() call)', () => {
    const prev = {
      ...initialHostStatus,
      settings: {
        loaded: true,
        hasAuthToken: true,
        hasBaseUrl: false,
        baseHost: null,
        model: 'opus',
      },
    };
    expect(primeHostStatus(prev, undefined).settings).toEqual(prev.settings);
    expect(primeHostStatus(prev, null).settings).toEqual(prev.settings);
  });

  it('resets pid to undefined when the snapshot carries no numeric pid (matches the pre-existing prime behavior)', () => {
    const prev = { ...initialHostStatus, pid: 123 };
    const next = primeHostStatus(prev, { state: 'ready' });
    expect(next.pid).toBeUndefined();
  });

  it('falls back to the prior state/driver/cometixVersion field-by-field when the snapshot omits them', () => {
    const prev: typeof initialHostStatus = {
      ...initialHostStatus,
      state: 'ready',
      driver: 'agent-sdk',
      cometixVersion: '2.1.212',
    };
    const next = primeHostStatus(prev, {});
    expect(next.state).toBe('ready');
    expect(next.driver).toBe('agent-sdk');
    expect(next.cometixVersion).toBe('2.1.212');
  });
});

describe('describeHostStatus — what the ribbon may say (field report 2026-09-07)', () => {
  function status(state: HostStatus['state'], extra: Partial<HostStatus> = {}): HostStatus {
    return { ...initialHostStatus, state, ...extra };
  }

  it('starts on `unknown`, not `stopped` — nothing has been asked yet', () => {
    expect(initialHostStatus.state).toBe('unknown');
    expect(describeHostStatus(initialHostStatus)).toBeNull();
  });

  it('says nothing for ready, unknown or degraded', () => {
    for (const state of ['ready', 'unknown', 'degraded'] as const) {
      expect(describeHostStatus(status(state)), state).toBeNull();
    }
  });

  it('speaks for a Main-confirmed stopped manager and offers Retry', () => {
    const model = describeHostStatus(status('stopped'));
    expect(model?.tone).toBe('notice');
    expect(model?.title).toContain('已停止');
    expect(model?.showRetry).toBe(true);
  });

  it('prefers the fatal message over the generic error title, and never renders an empty title', () => {
    expect(describeHostStatus(status('error', { lastFatalError: 'boom' }))?.title).toBe('boom');
    expect(describeHostStatus(status('error', { lastFatalError: null }))?.title).toBeTruthy();
    // The `degraded` hole this replaces: Main reports a state the Renderer's
    // union did not list, the old `Record` lookup returned undefined, and the
    // ribbon rendered a titleless bar with a Retry button on it.
    for (const state of ['stopped', 'starting', 'error'] as const) {
      expect(describeHostStatus(status(state))?.title, state).toBeTruthy();
    }
  });

  it('hides Retry while starting — there is nothing to retry mid-start', () => {
    expect(describeHostStatus(status('starting'))?.showRetry).toBe(false);
  });
});

describe('isHostUsable', () => {
  it('counts a degraded manager as usable and an unanswered one as not', () => {
    expect(isHostUsable('ready')).toBe(true);
    // One crashed pooled worker does not stop the manager serving every other
    // session: WorkerManager retires that entry on the next create/resume.
    expect(isHostUsable('degraded')).toBe(true);
    for (const state of ['unknown', 'stopped', 'starting', 'error'] as const) {
      expect(isHostUsable(state), state).toBe(false);
    }
  });
});

describe('useHostStatus wiring (node-env: source assertions, the hook needs a renderer)', () => {
  const source = stripComments(
    readFileSync(path.join(__dirname, '..', 'useHostStatus.ts'), 'utf8'),
    'useHostStatus.ts'
  );

  const compact = source.replace(/\s+/g, '');

  it('primes through ensureHost, falling back to a plain read only if it rejects', () => {
    // The bug this pins: priming with `getHostStatus` alone raced the
    // `ensureHost` fired by chatSessions.initRuntime on the same mount, won,
    // and left the ribbon claiming a stopped service for a full probe period.
    expect(compact).toContain('.ensureHost().catch(()=>window.electronAPI.chat.getHostStatus())');
  });

  it('applies the snapshot Retry returns instead of waiting for the next probe', () => {
    expect(compact).toContain('constsnapshot=awaitwindow.electronAPI.chat.ensureHost();');
    expect(compact).toContain('setStatus((prev)=>primeHostStatus(prev,snapshot));');
  });
});
