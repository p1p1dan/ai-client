import { describe, expect, it } from 'vitest';
import { WORKER_COMMAND_INVENTORY_MAX } from '../../shared/types/workerRpc.ts';
import { type PiCommandSources, readSlashCommandInventory } from '../commandInventory.ts';

/**
 * R02-a — the slash-command list the composer shows.
 *
 * pi's own `getCommands()` lives on the extension context, not on the
 * AgentSession an embedded host holds, so this module rebuilds the same list
 * from the same three sources pi's RPC mode uses. These tests pin the two
 * things that are easy to get subtly wrong: the `skill:` prefix, and staying
 * alive when one source misbehaves.
 */

function session(parts: Partial<PiCommandSources>): PiCommandSources {
  return parts;
}

describe('readSlashCommandInventory', () => {
  it('merges the three sources in pi’s own order', () => {
    const result = readSlashCommandInventory(
      session({
        extensionRunner: {
          getRegisteredCommands: () => [{ invocationName: 'plan', description: 'Plan mode' }],
        },
        promptTemplates: [{ name: 'review', description: 'Review template' }],
        resourceLoader: { getSkills: () => ({ skills: [{ name: 'pdf', description: 'PDFs' }] }) },
      })
    );

    expect(result.commands).toEqual([
      { name: 'plan', source: 'extension', description: 'Plan mode' },
      { name: 'review', source: 'prompt', description: 'Review template' },
      { name: 'skill:pdf', source: 'skill', description: 'PDFs' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('keeps pi’s skill: prefix, because that is what expansion matches on', () => {
    // `_expandSkillCommand` only fires on text starting with `/skill:`. A bare
    // name here would produce a command the runtime silently does not know.
    const result = readSlashCommandInventory(
      session({ resourceLoader: { getSkills: () => ({ skills: [{ name: 'plan-tree' }] }) } })
    );
    expect(result.commands[0]?.name).toBe('skill:plan-tree');
  });

  it('does not double the prefix when pi already applied it', () => {
    const result = readSlashCommandInventory(
      session({ resourceLoader: { getSkills: () => ({ skills: [{ name: 'skill:pdf' }] }) } })
    );
    expect(result.commands[0]?.name).toBe('skill:pdf');
  });

  it('carries where each command came from', () => {
    // The composer shows this: three kinds in one list, and the user needs to
    // be able to tell which directory a command arrived from.
    const result = readSlashCommandInventory(
      session({
        resourceLoader: {
          getSkills: () => ({
            skills: [
              {
                name: 'pdf',
                sourceInfo: { path: '/home/u/.agents/skills/pdf/SKILL.md', scope: 'user' },
              },
            ],
          }),
        },
      })
    );
    expect(result.commands[0]).toMatchObject({
      path: '/home/u/.agents/skills/pdf/SKILL.md',
      scope: 'user',
    });
  });

  it('drops unreadable entries instead of throwing', () => {
    const result = readSlashCommandInventory(
      session({
        extensionRunner: {
          getRegisteredCommands: () => [
            null,
            'not-a-record',
            { description: 'nameless' },
            { invocationName: '   ' },
            { invocationName: 'good' },
          ],
        },
      })
    );
    expect(result.commands).toEqual([{ name: 'good', source: 'extension' }]);
  });

  it('keeps the other two sources when one throws', () => {
    // A plugin that blows up while listing its own commands must not cost the
    // user their skills.
    const result = readSlashCommandInventory(
      session({
        extensionRunner: {
          getRegisteredCommands: () => {
            throw new Error('plugin exploded');
          },
        },
        promptTemplates: [{ name: 'review' }],
        resourceLoader: { getSkills: () => ({ skills: [{ name: 'pdf' }] }) },
      })
    );
    expect(result.commands.map((c) => c.name)).toEqual(['review', 'skill:pdf']);
  });

  it('survives an SDK that reports none of the three', () => {
    expect(readSlashCommandInventory(session({}))).toEqual({ commands: [], truncated: false });
    expect(readSlashCommandInventory(undefined)).toEqual({ commands: [], truncated: false });
  });

  it('caps the list and says so', () => {
    const skills = Array.from({ length: WORKER_COMMAND_INVENTORY_MAX + 5 }, (_, i) => ({
      name: `skill-${i}`,
    }));
    const result = readSlashCommandInventory(
      session({ resourceLoader: { getSkills: () => ({ skills }) } })
    );
    expect(result.commands).toHaveLength(WORKER_COMMAND_INVENTORY_MAX);
    expect(result.truncated).toBe(true);
  });
});
