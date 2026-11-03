import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Decision 207 §15, §14 G: the subagents card is rebuilt per session, so an
 * open row or the 「已结束」 fold of one chat never shows in the next. Checked
 * on the source: mounting the whole rail needs a dozen stores and the preload.
 */
describe('SessionRail wiring (static)', () => {
  it('keys the subagents card by session', () => {
    const source = readFileSync(join(__dirname, '..', 'sessionRail', 'SessionRail.tsx'), 'utf8');
    const element = source.slice(source.indexOf('<SubagentsCard'));
    const props = element.slice(0, element.indexOf('/>'));
    expect(props).toMatch(/key=\{`\$\{id\}:\$\{sessionId\}`\}/);
  });
});
