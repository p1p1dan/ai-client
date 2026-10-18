import { readFileSync } from 'node:fs';
import path from 'node:path';
import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

/**
 * Decision 193 rules 4 and 6 (2026-10-18): two controls a screen reader named
 * badly. The terminal's input said xterm's own English "Terminal input"; the
 * add-repository dialog's clear button was an icon with no name at all.
 */
const source = (...parts: string[]) =>
  stripComments(
    readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8'),
    parts.at(-1) ?? ''
  );

describe('the terminal input is named in the app’s language (rule 4)', () => {
  const XTERM = source('hooks', 'useXterm.ts');

  it('sets xterm’s localizable strings before each terminal is created', () => {
    expect(XTERM).toContain("Terminal.strings.promptLabel = translate(locale, 'Terminal input');");
    expect(XTERM).toMatch(
      /Terminal\.strings\.tooMuchOutput = translate\(\s*locale,\s*'Too much output to announce, navigate to rows manually to read'\s*\)/
    );
    expect(XTERM.indexOf('Terminal.strings.promptLabel')).toBeLessThan(
      XTERM.indexOf('new Terminal(')
    );
  });

  it('has the Chinese for both', () => {
    expect(translate('zh', 'Terminal input')).toBe('终端输入');
    expect(translate('zh', 'Too much output to announce, navigate to rows manually to read')).toBe(
      '输出太多，无法朗读，请逐行浏览'
    );
  });
});

describe('the add-repository clear button has a name (rule 6)', () => {
  it('the autocomplete input passes its clear label to the clear button', () => {
    const AUTOCOMPLETE = source('components', 'ui', 'autocomplete.tsx');
    expect(AUTOCOMPLETE).toContain("{...(clearLabel ? { 'aria-label': clearLabel } : {})}");
  });

  it('the dialog gives it 「清除」', () => {
    const DIALOG = source('components', 'git', 'AddRepositoryDialog.tsx');
    expect(DIALOG).toMatch(/showClear=\{!!localPath\}\s+clearLabel=\{t\('Clear'\)\}/);
    expect(translate('zh', 'Clear')).toBe('清除');
  });
});
