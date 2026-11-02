import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { lineNumberWidthClass } from '../DiffLayout';

describe('[PILAB-R2] the diff number column fits its largest line number', () => {
  it('widens for 4- and 5-digit numbers, on either side', () => {
    expect(lineNumberWidthClass([])).toBe('w-8');
    expect(lineNumberWidthClass([{ kind: 'same', text: '', oldLine: 999, newLine: 999 }])).toBe(
      'w-8'
    );
    expect(lineNumberWidthClass([{ kind: 'del', text: '', oldLine: 1000 }])).toBe('w-10');
    expect(lineNumberWidthClass([{ kind: 'add', text: '', newLine: 12_345 }])).toBe('w-12');
  });
});
