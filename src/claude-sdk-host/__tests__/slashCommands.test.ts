import { describe, expect, it } from 'vitest';
import {
  cliSlashCommands,
  commandRowLine,
  localCommandOutput,
  SDK_HIDDEN_COMMANDS,
  SDK_PILAB_OWNED_COMMANDS,
  sdkSlashCommandRows,
} from '../slashCommands.ts';

/**
 * dsh-rebase decision 194: the Claude Agent SDK engine's menu rows and command
 * transcript rows, against shapes measured on CLI 2.1.300 (`tools/slash-inventory.ts`).
 */

describe('cliSlashCommands', () => {
  it('keeps what the menu reads, and drops rows without a name', () => {
    expect(
      cliSlashCommands([
        {
          name: 'context',
          description: 'Show current context usage',
          argumentHint: '',
          builtin: true,
        },
        { name: 'inv-proj-skill', description: 'A skill', argumentHint: '', aliases: ['x'] },
        { name: '' },
        { description: 'nameless' },
        'context',
        null,
      ])
    ).toEqual([
      {
        name: 'context',
        description: 'Show current context usage',
        argumentHint: '',
        builtin: true,
      },
      { name: 'inv-proj-skill', description: 'A skill', argumentHint: '' },
    ]);
    expect(cliSlashCommands(undefined)).toEqual([]);
  });
});

describe('sdkSlashCommandRows', () => {
  const builtin = (name: string) => ({ name, description: `${name} built in`, builtin: true });
  const custom = (name: string) => ({ name, description: `${name} custom` });

  it('lists the CLI’s rows as commands and everyone else’s as skills, a plugin’s scoped', () => {
    expect(
      sdkSlashCommandRows([
        builtin('context'),
        builtin('dataviz'),
        custom('inv-proj-cmd'),
        custom('inv-plugin:inv-plugin-skill'),
      ])
    ).toEqual({
      commands: [
        { name: 'context', description: 'context built in', source: 'command' },
        // A skill the CLI ships is the CLI's own row.
        { name: 'dataviz', description: 'dataviz built in', source: 'command' },
        { name: 'inv-proj-cmd', description: 'inv-proj-cmd custom', source: 'skill' },
        {
          name: 'inv-plugin:inv-plugin-skill',
          description: 'inv-plugin:inv-plugin-skill custom',
          source: 'skill',
          scope: 'plugin',
        },
      ],
      truncated: false,
    });
  });

  it('leaves out the window’s /compact, the hidden, PiLab’s own and the terminal’s rows', () => {
    const all = [
      'compact',
      ...SDK_HIDDEN_COMMANDS,
      ...SDK_PILAB_OWNED_COMMANDS,
      'doctor',
      'color',
      'focus',
      'reload-plugins',
      'usage',
    ].map(builtin);
    expect(sdkSlashCommandRows(all).commands.map((row) => row.name)).toEqual(['usage']);
    // The CLI's own word on what is bound to a terminal replaces 2.1.300's.
    expect(
      sdkSlashCommandRows([builtin('doctor'), builtin('statusline')], ['statusline']).commands.map(
        (row) => row.name
      )
    ).toEqual(['doctor']);
  });

  it('never shows the CLI product’s name: its own words for update-config, none for others', () => {
    const rows = sdkSlashCommandRows([
      {
        name: 'update-config',
        description: 'Use this skill to configure the Claude Code harness via settings.json.',
        builtin: true,
      },
      { name: 'some-skill', description: 'Tunes Claude Code for you' },
      { name: 'insights', description: 'Analyze your Claude Code sessions', builtin: true },
    ]).commands;
    expect(rows).toEqual([
      {
        name: 'update-config',
        description:
          'Configure settings.json: hooks for automated behaviour, permissions and environment variables',
        source: 'command',
      },
      { name: 'some-skill', source: 'skill' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/claude code/i);
  });

  it('keeps the first of two rows of a name, and caps the list', () => {
    expect(
      sdkSlashCommandRows([builtin('goal'), custom('goal')]).commands.map((row) => row.source)
    ).toEqual(['command']);
    const many = Array.from({ length: 300 }, (_, i) => custom(`skill-${i}`));
    const result = sdkSlashCommandRows(many);
    expect(result.commands).toHaveLength(256);
    expect(result.truncated).toBe(true);
  });
});

describe('the transcript’s command rows', () => {
  it('reads a local command’s row and a skill’s row back as the line typed', () => {
    expect(
      commandRowLine(
        '<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>'
      )
    ).toEqual({ name: 'context', line: '/context' });
    expect(
      commandRowLine(
        '<command-message>inv-plugin:inv-plugin-skill</command-message>\n<command-name>/inv-plugin:inv-plugin-skill</command-name>\n<command-args>CC-ECHO and more</command-args>'
      )
    ).toEqual({
      name: 'inv-plugin:inv-plugin-skill',
      line: '/inv-plugin:inv-plugin-skill CC-ECHO and more',
    });
    expect(commandRowLine('typed by the user <command-name>/x</command-name>')).toBeNull();
    expect(commandRowLine('<command-message>no name</command-message>')).toBeNull();
  });

  it('reads a local command’s output without its tags', () => {
    expect(
      localCommandOutput('<local-command-stdout>## Context Usage\n\nok</local-command-stdout>')
    ).toBe('## Context Usage\n\nok');
    expect(localCommandOutput('<local-command-stderr>fatal: bad</local-command-stderr>')).toBe(
      'fatal: bad'
    );
    expect(localCommandOutput('<local-command-stdout></local-command-stdout>')).toBeNull();
    expect(localCommandOutput('plain text')).toBeNull();
  });
});

describe('decision 194 follow-up (field test 2026-10-18)', () => {
  it('leaves /auto-mode-setup out: its SDK form is a host wizard PiLab does not drive', () => {
    expect(SDK_HIDDEN_COMMANDS.has('auto-mode-setup')).toBe(true);
    expect(sdkSlashCommandRows([{ name: 'auto-mode-setup', builtin: true }]).commands).toEqual([]);
  });

  it('passes the CLI’s argument hint on, trimmed, and leaves a blank one out', () => {
    expect(
      sdkSlashCommandRows([
        { name: 'fork', description: 'Fork', argumentHint: ' [prompt] ', builtin: true },
        { name: 'context', description: 'Context', argumentHint: '', builtin: true },
      ]).commands
    ).toEqual([
      { name: 'fork', description: 'Fork', argumentHint: '[prompt]', source: 'command' },
      { name: 'context', description: 'Context', source: 'command' },
    ]);
  });
});
