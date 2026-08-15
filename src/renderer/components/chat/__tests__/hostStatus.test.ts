import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  type HostStatus,
  initialHostStatus,
  isNode24ResolutionFailure,
  primeHostStatus,
  reduceHostStatus,
} from '../hostStatus';

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

  /**
   * S3 slice 6 (A6): `capabilities.agents` is the HostAgentRegistry's wire
   * form (`host.ready`'s `capabilities.agents`) — same fold shape as
   * `thinking` above, plus filtering against the known `AgentWireName`
   * vocabulary so an unrecognized slug never reaches a consumer.
   */
  describe('capabilities.agents fold (A6)', () => {
    it('records capabilities.agents when host.ready advertises a codex-inclusive list', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { agents: ['claude-code', 'codex'] } })
      );
      expect(next.capabilities).toEqual({ thinking: undefined, agents: ['claude-code', 'codex'] });
    });

    it('records capabilities.agents=[claude-code] when the flag is off', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { agents: ['claude-code'] } })
      );
      expect(next.capabilities?.agents).toEqual(['claude-code']);
    });

    it('drops an unrecognized slug instead of forwarding it (newer Host, older renderer)', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { agents: ['claude-code', 'some-future-agent'] } })
      );
      expect(next.capabilities?.agents).toEqual(['claude-code']);
    });

    it('leaves agents undefined when capabilities exists but the field is absent', () => {
      const next = reduceHostStatus(initialHostStatus, event('host.ready', { capabilities: {} }));
      expect(next.capabilities).toEqual({ thinking: undefined, agents: undefined });
    });

    it('leaves agents undefined when the field is present but not an array (malformed payload)', () => {
      const next = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { agents: 'codex' } })
      );
      expect(next.capabilities?.agents).toBeUndefined();
    });

    it('preserves prior agents when host.ready carries no capabilities at all', () => {
      const prior = reduceHostStatus(
        initialHostStatus,
        event('host.ready', { capabilities: { agents: ['claude-code', 'codex'] } })
      );
      const next = reduceHostStatus(prior, event('host.ready', {}));
      expect(next.capabilities?.agents).toEqual(['claude-code', 'codex']);
    });

    it('an old payload with no capabilities key at all does not throw and leaves capabilities untouched', () => {
      expect(() => reduceHostStatus(initialHostStatus, event('host.ready', {}))).not.toThrow();
      const next = reduceHostStatus(initialHostStatus, event('host.ready', {}));
      expect(next.capabilities).toBeUndefined();
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

  /**
   * S3 slice 6 (A6/O6): `capabilities.agents` must ride this SAME prime
   * channel `settings` rides above — this file's own `settings` history is
   * the exact mistake `agents` must not repeat (a consumer mounting before
   * the first live `host.ready` learns everything else here and would
   * otherwise read `agents` as `undefined` forever).
   */
  describe('capabilities (A6)', () => {
    it('copies capabilities.agents from the Main-side snapshot onto a placeholder state', () => {
      const next = primeHostStatus(initialHostStatus, {
        state: 'ready',
        capabilities: { agents: ['claude-code', 'codex'] },
      });
      expect(next.capabilities).toEqual({ thinking: undefined, agents: ['claude-code', 'codex'] });
    });

    it('drops an unrecognized slug instead of forwarding it, same as reduceHostStatus', () => {
      const next = primeHostStatus(initialHostStatus, {
        state: 'ready',
        capabilities: { agents: ['claude-code', 'some-future-agent'] },
      });
      expect(next.capabilities?.agents).toEqual(['claude-code']);
    });

    it('preserves the prior capabilities when the snapshot has no capabilities key at all (old Main build)', () => {
      const prev: HostStatus = {
        ...initialHostStatus,
        capabilities: { agents: ['claude-code', 'codex'] },
      };
      const next = primeHostStatus(prev, { state: 'ready' });
      expect(next.capabilities).toEqual({ agents: ['claude-code', 'codex'] });
    });

    it('preserves the prior capabilities when the snapshot itself is missing (a failed/unresolved getHostStatus() call)', () => {
      const prev: HostStatus = {
        ...initialHostStatus,
        capabilities: { agents: ['claude-code', 'codex'] },
      };
      expect(primeHostStatus(prev, undefined).capabilities).toEqual(prev.capabilities);
      expect(primeHostStatus(prev, null).capabilities).toEqual(prev.capabilities);
    });

    it('preserves the prior capabilities when the snapshot carries an explicit capabilities:null (Host has not reported one yet)', () => {
      const prev: HostStatus = {
        ...initialHostStatus,
        capabilities: { agents: ['claude-code', 'codex'] },
      };
      const next = primeHostStatus(prev, { state: 'ready', capabilities: null });
      expect(next.capabilities).toEqual({ agents: ['claude-code', 'codex'] });
    });

    it('an old snapshot with no capabilities key at all does not throw', () => {
      expect(() => primeHostStatus(initialHostStatus, { state: 'ready' })).not.toThrow();
      expect(primeHostStatus(initialHostStatus, { state: 'ready' }).capabilities).toBeUndefined();
    });
  });
});
