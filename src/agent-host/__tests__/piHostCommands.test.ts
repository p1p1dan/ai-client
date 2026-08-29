import { describe, expect, it } from 'vitest';
import {
  hasSendableContent,
  readAttachments,
  readEffort,
  rejectsPermissionPreference,
} from '../piHostCommands.ts';

/**
 * The pi Host's command boundary.
 *
 * Every case below replaces a SILENT outcome with a loud one. The shared failure
 * they guard against is the same shape: the caller is told its request landed,
 * and nothing anywhere says the Host did not act on it.
 */

describe('readEffort', () => {
  it('accepts the five-word vocabulary', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(readEffort(effort)).toEqual({ ok: true, effort });
    }
  });

  it('treats an absent effort as "no request"', () => {
    expect(readEffort(undefined)).toEqual({ ok: true });
  });

  /** Refused, not dropped: dropping it is how an unapplied effort looked applied. */
  it('refuses anything outside the vocabulary', () => {
    for (const value of ['ultra', '', 3, null, {}]) {
      expect(readEffort(value)).toEqual({ ok: false });
    }
  });
});

describe('readAttachments', () => {
  it('reads the two kinds this Host can deliver', () => {
    expect(
      readAttachments([
        { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        { kind: 'text', mediaType: 'text/plain', data: 'hello' },
      ])
    ).toEqual({
      ok: true,
      attachments: [
        { kind: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' },
        { kind: 'text', mediaType: 'text/plain', data: 'hello' },
      ],
    });
  });

  it('treats an absent list as "no attachments"', () => {
    expect(readAttachments(undefined)).toEqual({ ok: true });
  });

  /** Named in the error, because the alternative is a file that just never arrives. */
  it('refuses an attachment kind it cannot deliver', () => {
    const read = readAttachments([{ kind: 'video', mediaType: 'video/mp4', data: 'V' }]);
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain('video');
  });

  it('refuses a malformed list', () => {
    expect(readAttachments('nope').ok).toBe(false);
    expect(readAttachments([null]).ok).toBe(false);
    expect(readAttachments([{ kind: 'text', mediaType: 'text/plain' }]).ok).toBe(false);
    expect(readAttachments([{ kind: 'text', mediaType: 'text/plain', data: '' }]).ok).toBe(false);
  });

  it('defaults a missing mediaType rather than refusing the send', () => {
    const read = readAttachments([{ kind: 'text', data: 'x' }]);
    expect(read).toEqual({ ok: true, attachments: [{ kind: 'text', mediaType: '', data: 'x' }] });
  });
});

describe('hasSendableContent', () => {
  /** The protocol's own words: "May be empty when attachments are present". */
  it('accepts an attachment-only send', () => {
    expect(hasSendableContent('', [{ kind: 'image', mediaType: 'image/png', data: 'A' }])).toBe(
      true
    );
  });

  it('accepts text with no attachments', () => {
    expect(hasSendableContent('hello', undefined)).toBe(true);
  });

  it('rejects a send with neither', () => {
    expect(hasSendableContent('', undefined)).toBe(false);
    expect(hasSendableContent('', [])).toBe(false);
  });
});

describe('rejectsPermissionPreference', () => {
  /**
   * `SessionPermissionPreference` has a claude-code arm and a codex arm and no
   * pi arm — there is no posture this command could describe for pi, whose
   * rules live in the permission plugin's own config.
   */
  it('refuses a permissionPreference addressed to the pi backend', () => {
    expect(
      rejectsPermissionPreference({
        permissionPreference: { agent: 'claude-code', permissionMode: 'default' },
      })
    ).toBe(true);
  });

  it('accepts a payload that does not carry one', () => {
    expect(rejectsPermissionPreference({ sessionId: 's1' })).toBe(false);
    expect(rejectsPermissionPreference(undefined)).toBe(false);
  });
});
