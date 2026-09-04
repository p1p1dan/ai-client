import { describe, expect, it } from 'vitest';
import {
  SESSION_PERMISSION_TIERS,
  type SessionPermissionTier,
} from '../../shared/types/sessionPermissionTier.ts';
import { createSessionTierAuthorizer, verdictForTier } from '../sessionTierAuthorizer.ts';

describe('verdictForTier', () => {
  describe('readonly', () => {
    it('denies write, edit and bash', () => {
      for (const surface of ['write', 'edit', 'bash']) {
        const v = verdictForTier('readonly', surface);
        expect(v.kind).toBe('deny');
        expect((v as { reason?: string }).reason).toBeTruthy();
      }
    });

    it('defers everything else', () => {
      for (const surface of ['read', 'skill', 'mcp', 'path', 'external_directory', undefined]) {
        expect(verdictForTier('readonly', surface)).toEqual({ kind: 'defer' });
      }
    });
  });

  describe('pragmatic', () => {
    it('defers all surfaces unconditionally', () => {
      for (const surface of [
        'write',
        'edit',
        'bash',
        'read',
        'skill',
        'mcp',
        'path',
        'external_directory',
        undefined,
      ]) {
        expect(verdictForTier('pragmatic', surface)).toEqual({ kind: 'defer' });
      }
    });
  });

  describe('handsoff', () => {
    it('allows write and edit', () => {
      expect(verdictForTier('handsoff', 'write')).toEqual({ kind: 'allow' });
      expect(verdictForTier('handsoff', 'edit')).toEqual({ kind: 'allow' });
    });

    it('defers bash and everything else', () => {
      for (const surface of [
        'bash',
        'read',
        'skill',
        'mcp',
        'path',
        'external_directory',
        undefined,
      ]) {
        expect(verdictForTier('handsoff', surface)).toEqual({ kind: 'defer' });
      }
    });
  });

  describe('fullopen', () => {
    it('allows all surfaces', () => {
      for (const surface of [
        'write',
        'edit',
        'bash',
        'read',
        'skill',
        'mcp',
        'path',
        'external_directory',
        undefined,
      ]) {
        expect(verdictForTier('fullopen', surface)).toEqual({ kind: 'allow' });
      }
    });
  });

  it('every tier returns a known verdict kind', () => {
    for (const tier of SESSION_PERMISSION_TIERS) {
      for (const surface of [
        'write',
        'edit',
        'bash',
        'read',
        'path',
        'external_directory',
        undefined,
      ]) {
        expect(['allow', 'deny', 'defer']).toContain(verdictForTier(tier, surface).kind);
      }
    }
  });

  // RELEASE BLOCKER: since the 2026-09-04 distributor patch exempts this link
  // from the bounded-delegation envelope, an `allow` here on path /
  // external_directory is FINAL — nothing downstream caps it back to a prompt.
  // Verify that ONLY fullopen (the tier behind the dangerous-tier
  // confirmation) emits it, and the other three tiers never do.
  it('[release-blocker] only fullopen allows path and external_directory; every other tier defers or denies', () => {
    const excludedSurfaces = ['path', 'external_directory'] as const;
    const nonFullTiers: SessionPermissionTier[] = ['readonly', 'pragmatic', 'handsoff'];
    for (const tier of nonFullTiers) {
      for (const surface of excludedSurfaces) {
        const v = verdictForTier(tier, surface);
        expect(v.kind, `${tier}/${surface}`).not.toBe('allow');
      }
    }
    // fullopen does allow, and that allow now reaches the gate unchanged.
    // This test documents the contract boundary.
    for (const surface of excludedSurfaces) {
      expect(verdictForTier('fullopen', surface).kind).toBe('allow');
    }
  });
});

describe('createSessionTierAuthorizer', () => {
  it('defaults to pragmatic', () => {
    const { state } = createSessionTierAuthorizer();
    expect(state.getTier()).toBe('pragmatic');
  });

  // U12 fix — `setTier` needs a live worker to talk to, so a tier chosen before
  // the first send, or one in force when a worker crashed, could not be
  // delivered and the runtime came up on the default while the composer chip
  // still showed the user's choice. Both drifts erred towards the more
  // permissive side, which is why the tier is now seeded at construction.
  it('starts on the tier it was seeded with', () => {
    expect(createSessionTierAuthorizer({ initialTier: 'readonly' }).state.getTier()).toBe(
      'readonly'
    );
    expect(createSessionTierAuthorizer({ initialTier: 'fullopen' }).state.getTier()).toBe(
      'fullopen'
    );
  });

  it('still defaults when no seed is given', () => {
    expect(createSessionTierAuthorizer({ initialTier: undefined }).state.getTier()).toBe(
      'pragmatic'
    );
  });

  it('lets setTier override the seed, both ways', () => {
    // The seed is a starting point, not a lock — the chip stays changeable at
    // any time, in either direction.
    const { state } = createSessionTierAuthorizer({ initialTier: 'readonly' });
    state.setTier('fullopen');
    expect(state.getTier()).toBe('fullopen');
    state.setTier('readonly');
    expect(state.getTier()).toBe('readonly');
  });

  it('setTier changes the tier immediately', () => {
    const { state } = createSessionTierAuthorizer();
    state.setTier('readonly');
    expect(state.getTier()).toBe('readonly');
    state.setTier('fullopen');
    expect(state.getTier()).toBe('fullopen');
  });

  it('factory tolerates missing event bus', () => {
    const logs: unknown[][] = [];
    const { factory } = createSessionTierAuthorizer({ log: (...args) => logs.push(args) });
    expect(() => factory({} as never)).not.toThrow();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('factory tolerates null/undefined pi', () => {
    const { factory } = createSessionTierAuthorizer();
    expect(() => factory(null as never)).not.toThrow();
    expect(() => factory(undefined as never)).not.toThrow();
  });
});
