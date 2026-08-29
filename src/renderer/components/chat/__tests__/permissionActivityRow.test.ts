import { describe, expect, it } from 'vitest';
import {
  derivePermissionActivityRow,
  mergePermissionActivity,
  type PermissionActivityRecord,
} from '../permissionActivityRow';

/**
 * The audit row for one permission gate.
 *
 * The distinction the tone carries is the whole point: a decision the USER made
 * and a decision a RULE made are different facts, and drawing them the same way
 * either overstates what the user agreed to or buries the automatic ones until
 * nobody notices the gate at all.
 */

function record(overrides: Partial<PermissionActivityRecord> = {}): PermissionActivityRecord {
  return { requestId: 'r1', ...overrides };
}

describe('derivePermissionActivityRow', () => {
  it('reads a user approval as a decision the user made', () => {
    const view = derivePermissionActivityRow(
      record({ surface: 'bash', value: 'ls -la', result: 'allow', resolution: 'user_approved' })
    );
    expect(view).toEqual({
      requestId: 'r1',
      tone: 'allowed',
      label: 'Allowed bash',
      detail: 'ls -la',
    });
  });

  /** A rule decided, not the user — quieter, and it says which rule. */
  it('reads a policy allow as automatic and names the rule', () => {
    const view = derivePermissionActivityRow(
      record({
        surface: 'read',
        value: '/repo/src/index.ts',
        result: 'allow',
        resolution: 'policy_allow',
        matchedPattern: 'src/**',
        origin: 'project',
      })
    );
    expect(view.tone).toBe('auto');
    expect(view.label).toBe('Allowed read');
    expect(view.note).toBe('policy allow · matched src/** · from project');
  });

  it('reads a denial as a denial whoever made it', () => {
    expect(derivePermissionActivityRow(record({ surface: 'bash', result: 'deny' })).tone).toBe(
      'denied'
    );
    expect(
      derivePermissionActivityRow(
        record({ surface: 'bash', result: 'deny', resolution: 'user_denied' })
      )
    ).toMatchObject({ tone: 'denied', label: 'Denied bash' });
  });

  /**
   * An unrecognised resolution falls on the QUIET side. Mislabelling an
   * automatic allow as a user decision would put words in the user's mouth,
   * which is the worse of the two errors — and this is a third-party enum that
   * can gain values in any upgrade.
   */
  it('treats a resolution it has never seen as automatic', () => {
    const view = derivePermissionActivityRow(
      record({ result: 'allow', resolution: 'some_future_resolution' })
    );
    expect(view.tone).toBe('auto');
    expect(view.note).toContain('some future resolution');
  });

  it('shows a gate with no verdict yet as pending', () => {
    const view = derivePermissionActivityRow(record({ phase: 'prompt', surface: 'bash' }));
    expect(view.tone).toBe('pending');
    expect(view.label).toBe('Awaiting approval — bash');
  });

  it('falls back to a neutral noun when the plugin sent no surface', () => {
    expect(derivePermissionActivityRow(record({ result: 'allow' })).label).toBe('Allowed request');
  });

  /** Approving a subagent's request is not the same act as approving one's own. */
  it('says when the ask came from a subagent', () => {
    expect(
      derivePermissionActivityRow(
        record({ result: 'allow', resolution: 'user_approved', forwarded: true })
      ).note
    ).toBe('for a subagent');
    expect(
      derivePermissionActivityRow(
        record({
          result: 'allow',
          resolution: 'user_approved',
          forwarded: true,
          requesterAgentName: 'explorer',
        })
      ).note
    ).toBe('for subagent explorer');
  });

  it('omits the detail when there is nothing to show', () => {
    expect(derivePermissionActivityRow(record({ result: 'allow' }))).not.toHaveProperty('detail');
  });
});

describe('mergePermissionActivity', () => {
  /** The decision does not repeat the command; blanking it would leave a verdict about nothing. */
  it('keeps earlier fields the newer record does not fill', () => {
    const merged = mergePermissionActivity(
      record({ phase: 'prompt', surface: 'bash', value: 'rm -rf /' }),
      record({ phase: 'decision', result: 'deny', resolution: 'user_denied' })
    );
    expect(merged).toEqual({
      requestId: 'r1',
      phase: 'decision',
      surface: 'bash',
      value: 'rm -rf /',
      result: 'deny',
      resolution: 'user_denied',
    });
  });

  /** Reference equality is how the store skips a re-render on redelivery. */
  it('returns the same object when nothing changed', () => {
    const previous = record({ result: 'allow', resolution: 'policy_allow' });
    expect(mergePermissionActivity(previous, { ...previous })).toBe(previous);
  });

  it('lets a later value win', () => {
    const previous = record({ result: 'allow' });
    expect(mergePermissionActivity(previous, record({ result: 'deny' })).result).toBe('deny');
  });
});
