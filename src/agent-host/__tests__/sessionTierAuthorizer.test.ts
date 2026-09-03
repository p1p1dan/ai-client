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

  // RELEASE BLOCKER: the delegation envelope caps path/external_directory
  // `allow` to `defer`, but the authorizer itself must never be the only
  // line of defence — verify that ONLY fullopen emits `allow` on these
  // surfaces, and the other three tiers never do.
  it('[release-blocker] only fullopen allows path and external_directory; every other tier defers or denies', () => {
    const excludedSurfaces = ['path', 'external_directory'] as const;
    const nonFullTiers: SessionPermissionTier[] = ['readonly', 'pragmatic', 'handsoff'];
    for (const tier of nonFullTiers) {
      for (const surface of excludedSurfaces) {
        const v = verdictForTier(tier, surface);
        expect(v.kind, `${tier}/${surface}`).not.toBe('allow');
      }
    }
    // fullopen does allow — which is fine because the delegation envelope
    // will cap it to defer. This test documents the contract boundary.
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
