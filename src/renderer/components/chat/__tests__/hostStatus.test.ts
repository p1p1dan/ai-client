import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { initialHostStatus, isNode24ResolutionFailure, reduceHostStatus } from '../hostStatus';

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
});
