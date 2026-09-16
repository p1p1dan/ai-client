import { type Translate, translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  derivePermissionActivityRow,
  mergePermissionActivity,
  type PermissionActivityRecord,
} from '../permissionActivityRow';

const zh: Translate = (key, params) => translate('zh', key, params);

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

  /**
   * permissions-08. The gate now produces `timed_out` for a countdown nobody
   * answered, and the row has to say the refusal came from the clock: written
   * down as `user_denied` it would claim the user refused a question they may
   * never have seen.
   */
  it('reads a countdown that ran out as a refusal nobody made', () => {
    const view = derivePermissionActivityRow(
      record({ surface: 'write', result: 'deny', resolution: 'timed_out' })
    );
    expect(view.tone).toBe('denied');
    expect(view.label).toBe('Denied write');
    // The note is what carries the reason, and only an automatic resolution
    // gets one: a user decision is drawn without an explanation.
    expect(view.note).toBe('timed out');
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

  /**
   * chat-event-07 — three places turned a machine enum into copy.
   *
   * The `gate_error` branch returned BEFORE `humanizeResolution`, so its note
   * was the raw `gate_error` (underscore and all) and the catalog's own
   * 「闸门出错」 was unreachable. The other resolutions did go through the
   * catalog but four of the gate's eight values had no entry — including
   * `session_grant`, which is what every call after "allow for this session"
   * resolves as.
   */
  it('words the gate’s own error instead of printing its enum', () => {
    const view = derivePermissionActivityRow(
      record({ surface: 'bash', result: 'deny', resolution: 'gate_error' }),
      zh
    );
    expect(view.note).toBe('闸门出错');
    expect(view.note).not.toContain('_');
  });

  it.each([
    ['session_grant', '本会话已授权'],
    ['policy_deny', '策略拒绝'],
    ['timed_out', '已超时'],
    ['cancelled', '已取消'],
  ])('has a word for %s, which the gate really does produce', (resolution, chinese) => {
    const view = derivePermissionActivityRow(
      record({ surface: 'bash', result: 'allow', resolution }),
      zh
    );
    expect(view.note).toBe(chinese);
  });

  /**
   * chat-tool-06 — the native gate sends the TOOL name as `surface`, and an MCP
   * tool's name is `mcp__<server>__<tool>`. The audit row read "Allowed
   * mcp__github__create_issue", a protocol identifier in a line a person is
   * meant to read, while the timeline row for the same call said
   * "github · create_issue".
   */
  it('names an MCP surface the way every other surface is named', () => {
    expect(
      derivePermissionActivityRow(record({ surface: 'mcp__github__create_issue', result: 'allow' }))
        .label
    ).toBe('Allowed github · create_issue');
    // Not a rewrite of every surface: the policy-vocabulary names pass through.
    expect(derivePermissionActivityRow(record({ surface: 'bash', result: 'allow' })).label).toBe(
      'Allowed bash'
    );
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
