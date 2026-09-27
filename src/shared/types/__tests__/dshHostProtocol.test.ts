import { describe, expect, it } from 'vitest';
import {
  DSH_CHANNEL_OPENING_METHODS,
  dshHostControlKind,
  formatDshChannelId,
  isDshChannelEnvelope,
  isDshChannelId,
  isDshHostChannelClosed,
  isDshHostCloseChannel,
  isDshHostFatal,
  isDshHostPing,
  isDshHostPong,
  isDshHostReady,
  isDshHostShutdown,
  isDshHostStopped,
  opensDshChannel,
} from '../dshHostProtocol';

const rpc = (type: string, kind = 'request') => ({
  protocolVersion: 1,
  kind,
  generation: 1,
  requestId: 'rpc-1',
  type,
  payload: {},
});

describe('dshHostProtocol channel ids', () => {
  it('mints c<host generation>-<sequence> and accepts only that shape', () => {
    expect(formatDshChannelId(2, 17)).toBe('c2-17');
    expect(isDshChannelId('c2-17')).toBe(true);
    for (const bad of ['c0-1', 'c1-0', 'c-1', 'c1-', '1-1', 'c01-1', ' c1-1', 'c1-1 ', 7, null]) {
      expect(isDshChannelId(bad), String(bad)).toBe(false);
    }
    expect(() => formatDshChannelId(0, 1)).toThrow();
    expect(() => formatDshChannelId(1, 1.5)).toThrow();
  });
});

describe('dshHostProtocol envelopes', () => {
  it('accepts {ch, rpc} with a record rpc in either direction', () => {
    expect(isDshChannelEnvelope({ ch: 'c1-1', rpc: rpc('worker.send') })).toBe(true);
    expect(isDshChannelEnvelope({ ch: 'c1-1', rpc: 'text' })).toBe(false);
    expect(isDshChannelEnvelope({ ch: 'slot-1', rpc: rpc('worker.send') })).toBe(false);
    expect(isDshChannelEnvelope({ slot: 'c1-1', rpc: rpc('worker.send') })).toBe(false);
  });

  it('lets only worker.bootstrap open a channel', () => {
    expect(DSH_CHANNEL_OPENING_METHODS).toEqual(['worker.bootstrap']);
    expect(opensDshChannel(rpc('worker.bootstrap'))).toBe(true);
    for (const other of ['worker.send', 'worker.dispose', 'utility.start', 'worker.stop']) {
      expect(opensDshChannel(rpc(other)), other).toBe(false);
    }
    expect(opensDshChannel(rpc('worker.bootstrap', 'event'))).toBe(false);
    expect(opensDshChannel(null)).toBe(false);
  });
});

describe('dshHostProtocol control messages', () => {
  it('recognizes Main -> host control', () => {
    expect(isDshHostPing({ host: 'ping', id: 3 })).toBe(true);
    expect(isDshHostPing({ host: 'ping' })).toBe(false);
    expect(isDshHostPing({ host: 'ping', id: 0 })).toBe(false);
    expect(isDshHostCloseChannel({ host: 'close', ch: 'c1-2' })).toBe(true);
    expect(isDshHostCloseChannel({ host: 'close', ch: '' })).toBe(false);
    expect(isDshHostShutdown({ type: 'shutdown' })).toBe(true);
    expect(isDshHostShutdown({ host: 'shutdown' })).toBe(false);
  });

  it('requires a real pid in ready', () => {
    expect(isDshHostReady({ type: 'ready', pid: 4242, node: 'v24' })).toBe(true);
    for (const pid of [0, -1, 1.5, Number.NaN, '4242', undefined]) {
      expect(isDshHostReady({ type: 'ready', pid }), String(pid)).toBe(false);
    }
  });

  it('recognizes fatal and stopped', () => {
    expect(isDshHostFatal({ type: 'fatal', message: 'bundles skipped' })).toBe(true);
    expect(isDshHostFatal({ type: 'fatal' })).toBe(true);
    expect(isDshHostFatal({ type: 'fatal', message: 42 })).toBe(false);
    expect(isDshHostStopped({ type: 'stopped', ms: 12, reason: 'ipc' })).toBe(true);
  });

  it('validates pong numbers and channel entries', () => {
    const pong = {
      host: 'pong',
      id: 1,
      eldMaxMs: 3.5,
      rssMb: 180,
      channels: [
        { ch: 'c1-1', busy: true },
        { ch: 'c1-2', busy: false },
      ],
    };
    expect(isDshHostPong(pong)).toBe(true);
    expect(isDshHostPong({ ...pong, channels: [] })).toBe(true);
    expect(isDshHostPong({ ...pong, id: undefined })).toBe(false);
    expect(isDshHostPong({ ...pong, eldMaxMs: -1 })).toBe(false);
    expect(isDshHostPong({ ...pong, rssMb: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isDshHostPong({ ...pong, channels: [{ ch: 'c1-1' }] })).toBe(false);
    expect(isDshHostPong({ ...pong, channels: [{ ch: 'x', busy: true }] })).toBe(false);
  });

  it('recognizes closed and reports unknown control kinds without accepting them', () => {
    expect(isDshHostChannelClosed({ host: 'closed', ch: 'c3-9' })).toBe(true);
    expect(isDshHostChannelClosed({ host: 'closed' })).toBe(false);
    expect(dshHostControlKind({ host: 'credential', id: 1 })).toBe('credential');
    expect(dshHostControlKind({ type: 'ready', pid: 1 })).toBeUndefined();
    expect(dshHostControlKind('ping')).toBeUndefined();
  });
});
