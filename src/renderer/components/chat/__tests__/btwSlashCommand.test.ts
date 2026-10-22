import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SLASH_COMMANDS, parseSlashLine, resolveSlashAction } from '../slashCommands';

/**
 * Layout 5f (ui-cohesion ruling L6): `/btw <question>` typed in the composer is
 * a side question — asked in the side chat, never sent into the conversation.
 */
describe('/btw in the composer', () => {
  it('is this window’s builtin and carries the question', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain('btw');
    const parsed = parseSlashLine('/btw  what did the last step change?  ');
    expect(parsed).toEqual({ name: 'btw', args: 'what did the last step change?' });
    expect(resolveSlashAction('btw', parsed?.args ?? '', 'builtin')).toEqual({
      type: 'btw',
      question: 'what did the last step change?',
    });
    // A bare `/btw` opens the side chat empty.
    expect(resolveSlashAction('btw', '', undefined)).toEqual({ type: 'btw', question: '' });
    // Multi-line questions stay whole.
    expect(parseSlashLine('/btw first line\nsecond')?.args).toBe('first line\nsecond');
    // Another name is not `/btw`.
    expect(parseSlashLine('/btwx q')?.name).toBe('btwx');
  });

  it('a skill or engine command that took the name keeps it', () => {
    expect(resolveSlashAction('btw', 'q', 'skill')).toEqual({ type: 'runtime' });
  });

  it('the composer hands the question to the side chat and sends nothing', () => {
    const source = readFileSync(join(__dirname, '../ChatComposer.tsx'), 'utf8');
    const start = source.indexOf("case 'btw': {");
    expect(start).toBeGreaterThan(0);
    const branch = source.slice(start, source.indexOf('break;', start));
    expect(branch).toContain('useSideChatStore.getState().ask(activeSessionId, action.question)');
    expect(branch).not.toMatch(/runSend|sendMessage|electronAPI\.chat\.send/);
    // The builtin runs before the send gate, so a running turn does not hold it back.
    const handleSend = source.indexOf('const handleSend = async');
    expect(
      source.indexOf('if (await runBuiltinSlash(trimmed)) return;', handleSend)
    ).toBeGreaterThan(handleSend);
  });
});
