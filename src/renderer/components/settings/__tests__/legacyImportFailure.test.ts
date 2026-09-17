import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { describeLegacyImportFailure, formatImportLimitBytes } from '../legacyImportFailure';

/**
 * T067 (D9) — the failed-import row.
 *
 * The 2026-09-17 field pass photographed one row reading `Claude session
 * exceeds the 4000-entry import limit` directly above the panel's own
 * 「新导入 0 个，已存在 0 个，失败 1 个。」 Three faults in one line: English
 * inside a Chinese screen, a byte ceiling printed as `67108864`, and nothing
 * telling the user what to do instead.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

describe('describeLegacyImportFailure', () => {
  it('words the entry ceiling in Chinese and names the next step', () => {
    const text = describeLegacyImportFailure(
      {
        error: 'Claude session exceeds the 4000-entry import limit',
        errorCode: 'source-entry-limit',
        errorParams: { limit: 4000 },
      },
      zh
    );
    expect(text).toContain('4000');
    // The remedy is the half that was missing entirely, not a nicety.
    expect(text).toContain('请改导入较小的对话');
    expect(text).not.toContain('Claude session exceeds');
  });

  it('words the byte ceiling as MiB, never as raw digits', () => {
    const text = describeLegacyImportFailure(
      {
        error: 'Claude session exceeds the 67108864-byte import limit',
        errorCode: 'source-byte-limit',
        errorParams: { limit: 67_108_864 },
      },
      zh
    );
    expect(text).toContain('64 MiB');
    expect(text).not.toContain('67108864');
    expect(text).toContain('请改导入较小的对话');
  });

  it('reverse: an uncoded failure keeps its raw detail, untouched', () => {
    // Deliberate. The remaining failures (a source that vanished, a permission
    // error) have no remedy to offer, and paraphrasing them would drop the
    // only part worth reporting.
    const raw = 'Claude session source could not be read';
    expect(describeLegacyImportFailure({ error: raw }, zh)).toBe(raw);
    expect(describeLegacyImportFailure(undefined, zh)).toBeUndefined();
  });

  it('reverse: the default translator still produces English, not a key', () => {
    const text = describeLegacyImportFailure({
      errorCode: 'source-byte-limit',
      errorParams: { limit: 67_108_864 },
    });
    expect(text).toBe(
      'This conversation is larger than 64 MiB, past the import limit. Import a smaller conversation, or split it up first.'
    );
  });

  it('ignores a code whose parameter did not survive the trip', () => {
    // A code without its number cannot produce a sentence; falling back to the
    // raw message beats printing 「超过了 undefined 条」.
    const raw = 'Claude session exceeds the 4000-entry import limit';
    expect(describeLegacyImportFailure({ error: raw, errorCode: 'source-entry-limit' }, zh)).toBe(
      raw
    );
  });
});

describe('formatImportLimitBytes', () => {
  it('uses binary units and drops a decimal that says nothing', () => {
    expect(formatImportLimitBytes(67_108_864)).toBe('64 MiB');
    expect(formatImportLimitBytes(1024)).toBe('1 KiB');
    expect(formatImportLimitBytes(512)).toBe('512 B');
    expect(formatImportLimitBytes(1_610_612_736)).toBe('1.5 GiB');
  });

  it('refuses to invent a size for a non-size', () => {
    expect(formatImportLimitBytes(0)).toBe('0 B');
    expect(formatImportLimitBytes(Number.NaN)).toBe('0 B');
    expect(formatImportLimitBytes(-1)).toBe('0 B');
  });
});
