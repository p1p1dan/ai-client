import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../SessionManagerView.tsx'), 'utf8');

describe('legacy import UI contract', () => {
  it('carries the selected source and namespaces project selection across sources', () => {
    expect(source).toContain("sourceKind: selectedProject.sourceKind ?? 'claude-code'");
    expect(source).toContain(
      ['$', "{project.sourceKind ?? 'claude-code'}:", '$', '{project.id}'].join('')
    );
    expect(source).toContain("project.sourceKind === 'codex' ? 'Codex' : 'Claude Code'");
  });

  it('starts with no selected sessions and requires explicit checkbox selection', () => {
    expect(source).toContain('useState<Set<string>>(() => new Set())');
    expect(source).toContain('onSelectedChange={(selected) => setSelected(session.id, selected)}');
    expect(source).toContain("t('Select all in this project')");
    expect(source).toContain('disabled={selectedSessionIds.size === 0');
  });

  it('reports each result and only opens through an explicit button', () => {
    expect(source).toContain('setReport(result.results)');
    expect(source).toContain('Imported sessions are not opened automatically');
    expect(source).toContain('onClick={() => onOpenImported?.(item.session');
    expect(source).not.toContain('onOpenImported?.(result');
  });

  it('uses accurate Pi continuation wording instead of Claude resume wording', () => {
    // The copy moved to dictionary keys (2026-09-11). What this pins is the
    // CLAIM — read-only copy, carry on in Pi — not the language it is in.
    expect(source).toContain('read-only');
    expect(source).toContain('carry on in Pi');
    expect(source).not.toContain('恢复 Claude');
    expect(source).not.toContain('Resume Claude');
  });
});
