import { describe, expect, it } from 'vitest';
import { translate, zhTranslations } from '../i18n';
import { FORK_TITLE_KEY, forkSessionTitle, NEW_CHAT_TITLE } from '../sessionTitles';

/**
 * dsh-rebase P1-7e e6 (problem 40, decision 145): a fork's title is worded in
 * the app's language when Main creates it. Titles already stored are names,
 * and nothing rewrites them.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

describe('forkSessionTitle', () => {
  it('[E6-40-FORK] appends 「（分叉）」 in Chinese and ` (fork)` in English', () => {
    expect(forkSessionTitle('整理笔记', zh)).toBe('整理笔记（分叉）');
    expect(forkSessionTitle('Fix the build', zh)).toBe('Fix the build（分叉）');
    expect(forkSessionTitle('Fix the build')).toBe('Fix the build (fork)');
    expect(zhTranslations[FORK_TITLE_KEY]).toBe('{{title}}（分叉）');
  });

  it('names a fork of a placeholder chat by the placeholder as shown, never the identifier', () => {
    expect(forkSessionTitle(NEW_CHAT_TITLE, zh)).toBe('新建对话（分叉）');
    expect(forkSessionTitle('Live Agent Host', zh)).toBe('新建对话（分叉）');
    expect(forkSessionTitle('   ', zh)).toBe('新建对话（分叉）');
    expect(forkSessionTitle('')).toBe('New chat (fork)');
  });

  it('keeps a title that merely looks like a template', () => {
    expect(forkSessionTitle('{{title}} draft', zh)).toBe('{{title}} draft（分叉）');
  });
});
