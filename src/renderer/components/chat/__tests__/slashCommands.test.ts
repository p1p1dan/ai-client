import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SLASH_COMMANDS,
  buildSlashCatalog,
  extractSlashQuery,
  filterSlashCommands,
  parseSlashLine,
  replaceSlashCommand,
  resolveSlashAction,
  type SlashCatalogItem,
} from '../slashCommands.ts';

/**
 * R02-c — slash command parsing and routing.
 *
 * The load-bearing claims here are the two that fail silently when wrong:
 * a command is only a command at the start of a message, and this window never
 * takes a name a plugin already registered.
 */

const item = (name: string, source = 'skill', description = ''): SlashCatalogItem => ({
  name,
  source,
  description,
});

describe('parseSlashLine', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlashLine('/compact keep the API decisions')).toEqual({
      name: 'compact',
      args: 'keep the API decisions',
    });
    expect(parseSlashLine('/new')).toEqual({ name: 'new', args: '' });
    expect(parseSlashLine('  /new  ')).toEqual({ name: 'new', args: '' });
  });

  it('does not treat prose containing a slash as a command', () => {
    // pi does not either: `prompt()` only dispatches when the text STARTS with
    // the command.
    expect(parseSlashLine('look in the /tmp directory')).toBeNull();
    expect(parseSlashLine('/')).toBeNull();
    expect(parseSlashLine('')).toBeNull();
  });

  it('keeps the skill: prefix intact', () => {
    expect(parseSlashLine('/skill:plan-tree go')).toEqual({
      name: 'skill:plan-tree',
      args: 'go',
    });
  });
});

describe('extractSlashQuery', () => {
  it('opens while the caret is inside the first token', () => {
    expect(extractSlashQuery('/ne', 3)).toBe('ne');
    expect(extractSlashQuery('/', 1)).toBe('');
  });

  it('closes once the name is settled by a space', () => {
    // Past that point the user is typing arguments, and a menu would be in the
    // way.
    expect(extractSlashQuery('/compact ', 9)).toBeNull();
    expect(extractSlashQuery('/compact keep', 13)).toBeNull();
  });

  it('never opens on a slash that is not the first character', () => {
    expect(extractSlashQuery('look in /tmp', 12)).toBeNull();
    expect(extractSlashQuery('a /new', 6)).toBeNull();
  });

  it('does not open when the caret is before the slash', () => {
    expect(extractSlashQuery('/new', 0)).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  it('puts prefix matches first', () => {
    // `renew` contains the needle but does not start with it, so it sorts after
    // `new`. `rename` has no `w` and drops out entirely.
    const rows = filterSlashCommands([item('renew'), item('rename'), item('new')], 'new');
    expect(rows.map((r) => r.name)).toEqual(['new', 'renew']);
  });

  it('matches descriptions too', () => {
    // Someone who remembers what a command does but not its name.
    const rows = filterSlashCommands(
      [item('compact', 'builtin', 'Compact the context'), item('new', 'builtin', 'Start fresh')],
      'context'
    );
    expect(rows.map((r) => r.name)).toEqual(['compact']);
  });

  it('returns everything for an empty query, capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`cmd-${i}`));
    expect(filterSlashCommands(many, '')).toHaveLength(24);
  });
});

describe('buildSlashCatalog', () => {
  const translate = (key: string) => key;

  it('adds this window’s own commands to pi’s', () => {
    const catalog = buildSlashCatalog([item('skill:pdf')], translate);
    expect(catalog.map((c) => c.name)).toContain('skill:pdf');
    for (const builtin of BUILTIN_SLASH_COMMANDS) {
      expect(catalog.map((c) => c.name)).toContain(builtin.name);
    }
  });

  it('lets pi keep a name a plugin already registered', () => {
    // Load-bearing: a client that quietly takes a plugin's name breaks it in a
    // way neither the user nor the plugin author can see.
    const catalog = buildSlashCatalog([item('new', 'extension', 'Plugin new')], translate);
    const rows = catalog.filter((c) => c.name === 'new');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('extension');
  });
});

describe('resolveSlashAction', () => {
  it('maps this window’s commands to actions', () => {
    expect(resolveSlashAction('new', '', 'builtin')).toEqual({ type: 'new' });
    expect(resolveSlashAction('settings', '', 'builtin')).toEqual({ type: 'settings' });
    expect(resolveSlashAction('archive', '', 'builtin')).toEqual({ type: 'archive' });
    expect(resolveSlashAction('compact', '', 'builtin')).toEqual({ type: 'compact' });
    expect(resolveSlashAction('compact', 'keep decisions', 'builtin')).toEqual({
      type: 'compact',
      instructions: 'keep decisions',
    });
  });

  it('hands the name back to pi when pi owns it', () => {
    // The first line of the function. Without it, adding a builtin silently
    // shadows any plugin that already took the name.
    expect(resolveSlashAction('new', '', 'extension')).toEqual({ type: 'runtime' });
    expect(resolveSlashAction('compact', 'x', 'skill')).toEqual({ type: 'runtime' });
    expect(resolveSlashAction('settings', '', 'prompt')).toEqual({ type: 'runtime' });
  });

  it('sends an unknown name to pi rather than guessing', () => {
    // A newer plugin is far likelier than a typo, and pi reports what it does
    // not recognise.
    expect(resolveSlashAction('whatever', '', undefined)).toEqual({ type: 'runtime' });
    expect(resolveSlashAction('skill:pdf', '', 'skill')).toEqual({ type: 'runtime' });
  });
});

describe('replaceSlashCommand', () => {
  it('completes the name and leaves the caret after a trailing space', () => {
    expect(replaceSlashCommand('/comp', 'compact')).toEqual({
      text: '/compact ',
      cursor: 9,
    });
  });

  it('keeps arguments the user already typed', () => {
    expect(replaceSlashCommand('/comp keep this', 'compact')).toEqual({
      text: '/compact keep this',
      cursor: 9,
    });
  });
});
