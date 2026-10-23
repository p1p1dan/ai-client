import type { SessionControlChange } from '@shared/types/sessionControl';
import { describe, expect, it } from 'vitest';
import { SessionControlRegistry } from '../sessionControl';

const phone = { ownerId: -1, pluginId: 'pilab.remote-access', label: '网页 · iPhone' };

describe('SessionControlRegistry (plugin-system §4)', () => {
  it('[PLG-CONTROL] the desktop controls every session until a client takes one over', () => {
    const registry = new SessionControlRegistry();
    expect(registry.get('s1')).toEqual({ kind: 'desktop' });
    expect(() => registry.assertMayChange('s1', 7)).not.toThrow();
    expect(() => registry.assertMayChange('s1', undefined)).not.toThrow();
    expect(() => registry.assertMayChange('s1', -1)).toThrow(/^session_controlled_elsewhere/);
  });

  it('[PLG-CONTROL] a client that took over is the only one that may change it', () => {
    const registry = new SessionControlRegistry();
    registry.acquireForClient('s1', phone);
    expect(() => registry.assertMayChange('s1', -1)).not.toThrow();
    expect(() => registry.assertMayChange('s1', 7)).toThrow(/网页 · iPhone/);
    expect(() => registry.assertMayChange('s1', -2)).toThrow(/^session_controlled_elsewhere/);
    // Other sessions stay the desktop's.
    expect(() => registry.assertMayChange('s2', 7)).not.toThrow();
  });

  it('[PLG-CONTROL] the desktop takes it back, and a client that leaves gives everything back', () => {
    const registry = new SessionControlRegistry();
    const changes: SessionControlChange[] = [];
    registry.onChange((change) => changes.push(change));
    registry.acquireForClient('s1', phone);
    registry.acquireForClient('s1', phone); // no-op, no second change
    registry.acquireForDesktop('s1');
    registry.acquireForDesktop('s1'); // already the desktop's
    registry.acquireForClient('s1', phone);
    registry.acquireForClient('s2', phone);
    expect(registry.list().map((c) => c.sessionId)).toEqual(['s1', 's2']);
    registry.releaseOwner(-1);
    expect(registry.list()).toEqual([]);
    expect(changes.map((c) => [c.sessionId, c.controller.kind])).toEqual([
      ['s1', 'client'],
      ['s1', 'desktop'],
      ['s1', 'client'],
      ['s2', 'client'],
      ['s1', 'desktop'],
      ['s2', 'desktop'],
    ]);
  });

  it('[PLG-CONTROL] refuses a client with a window-shaped owner id', () => {
    const registry = new SessionControlRegistry();
    expect(() => registry.acquireForClient('s1', { ...phone, ownerId: 3 })).toThrow();
  });
});
