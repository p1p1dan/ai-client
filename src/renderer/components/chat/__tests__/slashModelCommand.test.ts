import { describe, expect, it } from 'vitest';
import { sdkBlockedCommandHint } from '../homeSlashCommands';
import { BUILTIN_SLASH_COMMANDS, resolveSlashAction } from '../slashCommands';
import {
  carriedGenerationPreferences,
  resolveEffortCommand,
  resolveModelCommand,
} from '../slashModelCommand';

/**
 * dsh-rebase decision 194 Q2 (user, 2026-10-18): `/clear`, `/model` and `/effort` are this
 * window's commands; the SDK CLI's `/config` and `/autocompact` are not sent.
 */

const rows = [
  { id: 'automatic', label: 'Automatic' },
  { id: 'gw/claude-opus-5-5', label: 'claude-opus-5-5' },
  { id: 'gw/claude-sonnet-5-5', label: 'claude-sonnet-5-5' },
  { id: 'other/glm-fake-1', label: 'glm-fake-1', locked: true },
];

describe('resolveModelCommand', () => {
  it('opens the menu with no name', () => {
    expect(resolveModelCommand('', rows)).toEqual({ kind: 'open' });
    expect(resolveModelCommand('   ', rows)).toEqual({ kind: 'open' });
  });

  it('picks a row by id, by label, by the id after its provider, or by a unique part', () => {
    for (const query of ['gw/claude-opus-5-5', 'CLAUDE-OPUS-5-5', 'opus']) {
      expect(resolveModelCommand(query, rows)).toEqual({ kind: 'pick', id: 'gw/claude-opus-5-5' });
    }
  });

  it('a row the chat cannot switch to is named, not picked', () => {
    expect(resolveModelCommand('glm-fake-1', rows)).toEqual({
      kind: 'locked',
      id: 'other/glm-fake-1',
    });
  });

  it('an ambiguous, unknown or Automatic name opens the menu with the query', () => {
    expect(resolveModelCommand('claude', rows)).toEqual({ kind: 'unknown', query: 'claude' });
    expect(resolveModelCommand('gpt-9', rows)).toEqual({ kind: 'unknown', query: 'gpt-9' });
    expect(resolveModelCommand('automatic', rows)).toEqual({
      kind: 'unknown',
      query: 'automatic',
    });
  });
});

describe('resolveEffortCommand', () => {
  const efforts = [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'X-High' },
  ];
  const zh = (key: string) => ({ Low: '低', High: '高', 'X-High': '超高' })[key] ?? key;

  it('picks a level by id, label, translated label or the CLI’s spelling', () => {
    expect(resolveEffortCommand('high', efforts)).toEqual({ kind: 'pick', id: 'high' });
    expect(resolveEffortCommand('X-High', efforts)).toEqual({ kind: 'pick', id: 'xhigh' });
    expect(resolveEffortCommand('超高', efforts, zh)).toEqual({ kind: 'pick', id: 'xhigh' });
    expect(resolveEffortCommand('auto', efforts)).toEqual({ kind: 'pick', id: 'default' });
  });

  it('opens the menu with no level, and names one the model does not have', () => {
    expect(resolveEffortCommand('', efforts)).toEqual({ kind: 'open' });
    expect(resolveEffortCommand('max', efforts)).toEqual({ kind: 'unknown', query: 'max' });
  });
});

describe('carriedGenerationPreferences', () => {
  it('carries the chat’s model and effort; Automatic and the default clear the template’s', () => {
    expect(carriedGenerationPreferences('gw/m', 'high')).toEqual({ model: 'gw/m', effort: 'high' });
    expect(carriedGenerationPreferences('automatic', 'default')).toEqual({
      model: undefined,
      effort: undefined,
    });
    expect(carriedGenerationPreferences(null, null)).toBeNull();
  });
});

describe('the window’s /clear, /model and /effort', () => {
  it('are builtins, /clear and the CLI’s /reset starting over as /new does', () => {
    const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(['clear', 'model', 'effort']));
    expect(resolveSlashAction('clear', '', 'builtin')).toEqual({ type: 'new' });
    expect(resolveSlashAction('reset', '', undefined)).toEqual({ type: 'new' });
    expect(resolveSlashAction('model', 'opus', 'builtin')).toEqual({
      type: 'model',
      query: 'opus',
    });
    expect(resolveSlashAction('effort', '', 'builtin')).toEqual({ type: 'effort', query: '' });
  });

  it('a skill or engine command that took the name keeps it', () => {
    expect(resolveSlashAction('model', 'x', 'skill')).toEqual({ type: 'runtime' });
    expect(resolveSlashAction('reset', '', 'command')).toEqual({ type: 'runtime' });
  });
});

describe('sdkBlockedCommandHint', () => {
  it('holds back the SDK CLI’s /config and /autocompact only', () => {
    expect(sdkBlockedCommandHint('config', undefined, 'claude-sdk')).toContain('/settings');
    expect(sdkBlockedCommandHint('autocompact', undefined, 'claude-sdk')).toContain(
      'context window'
    );
    expect(sdkBlockedCommandHint('config', undefined, 'dsh')).toBeNull();
    expect(sdkBlockedCommandHint('config', 'skill', 'claude-sdk')).toBeNull();
    expect(sdkBlockedCommandHint('context', undefined, 'claude-sdk')).toBeNull();
  });
});
