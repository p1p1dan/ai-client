import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('../ChatComposer.tsx', import.meta.url)), 'utf8');

function resumeBranch(): string {
  const start = SOURCE.indexOf("} else if (preamble.action === 'resume') {");
  const end = SOURCE.indexOf("// 'direct':", start);
  if (start < 0 || end < 0) throw new Error('ChatComposer Pi resume branch not found');
  return SOURCE.slice(start, end);
}

describe('T32 known-file resume safety', () => {
  it('never falls back to create when the authoritative Pi session file fails to resume', () => {
    const branch = resumeBranch();
    expect(branch).not.toContain('runCreateSequence(');
    expect(branch).toContain('Pi session resume timed out');
    expect(branch).toContain('return finalizeOutcome(');
  });

  it('reopens a known identity after a stale direct binding instead of creating unrelated history', () => {
    const start = SOURCE.indexOf(
      "if (preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found')"
    );
    const end = SOURCE.indexOf('// R3: no `useChatSessionsStore', start);
    const branch = SOURCE.slice(start, end);
    expect(branch).toContain('if (knownIdentity)');
    expect(branch).toContain('.resumeSession({');
    expect(branch.indexOf('.resumeSession({')).toBeLessThan(branch.indexOf('runCreateSequence('));
    expect(branch).toContain('sole safe create fallback');
  });
});
