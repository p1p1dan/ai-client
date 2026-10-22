import { englishTranslate, translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_BUILTINS,
  homeSlashMenu,
  homeSlashRefusal,
  homeSlashRefusalToast,
} from '../homeSlashCommands';
import { buildSlashCatalog, type SlashCatalogItem, slashCatalogRequest } from '../slashCommands';

/**
 * dsh-rebase decision 175 (GitHub issue #6 follow-up): what the home page —
 * no conversation open — does with a slash command.
 */

const row = (name: string, source: string, description = ''): SlashCatalogItem => ({
  name,
  source,
  description,
});

describe('the home page menu', () => {
  it('leaves out this window’s commands that act on the open conversation', () => {
    const catalog = buildSlashCatalog(
      [row('goal', 'command', 'Set or view the goal'), row('plan-tree', 'skill', 'Plans')],
      (key) => key
    );
    // Decision 194: `/model` and `/effort` work here too; `/clear` has nothing to clear.
    // Layout 5f (user, 2026-10-22): `/btw` stays listed, saying it needs an open conversation.
    expect(homeSlashMenu(catalog).map((item) => item.name)).toEqual([
      'btw',
      'effort',
      'goal',
      'model',
      'new',
      'plan-tree',
      'settings',
    ]);
    // Layout 5f: `/btw` asks about the open conversation.
    expect([...CONVERSATION_BUILTINS].sort()).toEqual(['archive', 'btw', 'clear', 'compact']);
    expect(homeSlashMenu(catalog).find((item) => item.name === 'btw')?.description).toBe(
      'Ask a side question about an open conversation (open one first)'
    );
  });

  it('keeps a plugin’s or skill’s command that took one of those names', () => {
    expect(homeSlashMenu([row('archive', 'skill', 'Archive files')])).toEqual([
      row('archive', 'skill', 'Archive files'),
    ]);
  });
});

describe('homeSlashRefusal', () => {
  it.each([
    ['compact', '', 'builtin', 'conversation'],
    ['compact', 'keep the API notes', 'builtin', 'conversation'],
    ['archive', '', 'builtin', 'conversation'],
    // Layout 5f: a side question needs a conversation to read.
    ['btw', 'what changed?', 'builtin', 'conversation'],
    // Not in the catalog (no worker answered): still this window's.
    ['archive', '', undefined, 'conversation'],
    ['goal', '', 'command', 'goal'],
    ['goal', 'pause', 'command', 'goal'],
    ['goal', 'resume', undefined, 'goal'],
    ['goal', 'clear', 'command', 'goal'],
    ['goal', 'edit ship it sooner', 'command', 'goal'],
    // DSH runs `/goal` as its command whatever the catalog calls it.
    ['goal', '', 'skill', 'goal'],
  ] as const)('refuses /%s %s (source %s)', (name, args, source, expected) => {
    expect(homeSlashRefusal(name, args, source)).toBe(expected);
  });

  it.each([
    // A goal with an objective starts the new conversation with it.
    ['goal', 'ship the release notes', 'command'],
    ['new', '', 'builtin'],
    ['settings', '', 'builtin'],
    ['plan-tree', 'draft the roadmap', 'skill'],
    ['plan-tree', '', undefined],
    // A plugin or skill that took a window name keeps it.
    ['compact', '', 'skill'],
    ['archive', 'old notes', 'command'],
    // Text to the model, as in any conversation.
    ['plan', 'the refactor', undefined],
  ] as const)('lets /%s %s (source %s) go out', (name, args, source) => {
    expect(homeSlashRefusal(name, args, source)).toBeNull();
  });

  it('decision 194: on the SDK engine /goal is the CLI’s and goes out; the window’s two stay refused', () => {
    for (const args of ['', 'pause', 'clear']) {
      expect(homeSlashRefusal('goal', args, 'command', 'claude-sdk')).toBeNull();
    }
    expect(homeSlashRefusal('goal', '', 'command', 'dsh')).toBe('goal');
    expect(homeSlashRefusal('compact', '', 'builtin', 'claude-sdk')).toBe('conversation');
    expect(homeSlashRefusal('archive', '', undefined, 'claude-sdk')).toBe('conversation');
  });
});

describe('the hint', () => {
  it('names the command, and gives /goal its own way forward', () => {
    expect(homeSlashRefusalToast('conversation', 'compact', englishTranslate)).toEqual({
      title: 'This command needs an open conversation',
      description:
        '/compact works on an open conversation. Open one from the sidebar or the recent list, then run it there.',
    });
    expect(homeSlashRefusalToast('goal', 'goal', englishTranslate).description).toBe(
      'To start a goal from here, write it after /goal. Showing, pausing, resuming, editing or clearing a goal works in its conversation.'
    );
  });

  it('is translated', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    expect(homeSlashRefusalToast('conversation', 'archive', zh)).toEqual({
      title: '这个命令需要先打开一个对话',
      description:
        '/archive 作用于打开的对话。请先从侧栏或「最近对话」打开一个对话，再在那里输入。',
    });
    expect(homeSlashRefusalToast('goal', 'goal', zh).description).toContain(
      '把目标写在 /goal 后面'
    );
  });
});

describe('slashCatalogRequest', () => {
  it('names the chat when there is one, and the folder whenever there is one', () => {
    expect(slashCatalogRequest('s1', '/repo/alpha')).toEqual({
      sessionId: 's1',
      workspacePath: '/repo/alpha',
      engine: 'dsh',
    });
    // The home page: the draft target's folder.
    expect(slashCatalogRequest(null, '/repo/beta')).toEqual({
      workspacePath: '/repo/beta',
      engine: 'dsh',
    });
    // A temporary chat before its first send, or 「不选仓库」 on the home page.
    expect(slashCatalogRequest('s2', null)).toEqual({ sessionId: 's2', engine: 'dsh' });
    expect(slashCatalogRequest(null, null)).toEqual({ engine: 'dsh' });
  });

  it('decision 194: names the engine the menu is for', () => {
    expect(slashCatalogRequest(null, '/repo', 'claude-sdk')).toEqual({
      workspacePath: '/repo',
      engine: 'claude-sdk',
    });
  });
});
