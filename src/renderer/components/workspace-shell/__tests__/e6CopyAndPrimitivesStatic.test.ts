import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-7e e6 (decision 145) — the small copy and style fixes that a
 * render cannot cheaply show, pinned against the source.
 *
 *  - Problem 42 and decision 144's findings: Chinese at 10px. The design
 *    system's CJK cascade rule 3 keeps CJK off `text-2xs` and off the small
 *    Badge (`sm:text-[.625rem]`), and these places put a translated sentence
 *    or word there.
 *  - Decision 144's findings: buttons whose label mixes scripts must opt out
 *    of the button base's `lowercase` with `normal-case` (design system,
 *    "按钮文案强制小写").
 *  - Decision 144's findings: the interface primitives' labels a screen reader
 *    announces (dialog / sheet close, toast close, window controls) go
 *    through the catalog.
 */

const COMPONENTS = join(process.cwd(), 'src/renderer/components');

function code(relative: string): string {
  const file = join(COMPONENTS, relative);
  return stripComments(readFileSync(file, 'utf8'), file);
}

/** A 10px element whose first child is a translated string. */
const TEN_PX_TRANSLATED = /text-2xs[^>]*>\s*\{t\(/;
/** A small Badge whose first child is a translated string. */
const SMALL_BADGE_TRANSLATED = /<Badge[^>]*size="sm"[^>]*>\s*\{t\(/;

describe('no translated text at 10px (problem 42, decision 145)', () => {
  it.each([
    'workspace-shell/SessionReviewPanel.tsx',
    'workspace-shell/SessionBar.tsx',
    'chat/BackgroundJobsWindow.tsx',
  ])('%s', (file) => {
    const source = code(file);
    expect(source).not.toMatch(TEN_PX_TRANSLATED);
    expect(source).not.toMatch(SMALL_BADGE_TRANSLATED);
  });

  it('the scan sees the shape it bans', () => {
    expect('<p className="px-1 text-2xs">\n  {t(\'x\')}').toMatch(TEN_PX_TRANSLATED);
    expect('<Badge variant="outline" size="sm" className="x">\n  {t(\'x\')}').toMatch(
      SMALL_BADGE_TRANSLATED
    );
  });
});

describe('mixed-script button labels keep their capitals (decision 145)', () => {
  it('GitMissingNotice: 「安装 Git」 and 「去下载 Git」', () => {
    const source = code('layout/GitMissingNotice.tsx');
    for (const key of ["t('Install Git')", "t('Get Git')"]) {
      const at = source.indexOf(key);
      expect(at, key).toBeGreaterThan(-1);
      const opening = source.lastIndexOf('<Button', at);
      expect(source.slice(opening, at), key).toContain('normal-case');
    }
  });

  it('AppearanceSettings: 「URL 模式」', () => {
    const source = code('settings/AppearanceSettings.tsx');
    const at = source.indexOf("t('URL Mode')");
    const opening = source.lastIndexOf('<Button', at);
    expect(source.slice(opening, at)).toMatch(/backgroundSourceType === 'url' && 'normal-case'/);
  });
});

describe('interface primitives label themselves in the UI language (decision 145)', () => {
  it.each([
    ['ui/dialog.tsx', ["aria-label={t('Close')}"]],
    ['ui/sheet.tsx', ["aria-label={t('Close')}"]],
    ['ui/toast.tsx', ["aria-label={t('Close notification')}"]],
    [
      'layout/WindowControls.tsx',
      [
        "aria-label={t('Minimize')}",
        "aria-label={isMaximized ? t('Restore') : t('Maximize')}",
        "aria-label={t('Close')}",
      ],
    ],
  ])('%s', (file, labels) => {
    const source = code(file);
    for (const label of labels) expect(source).toContain(label);
    // No label left as a bare English literal.
    expect(source).not.toMatch(/aria-label="(Close|Close notification|Minimize|Maximize|Restore)"/);
  });
});
