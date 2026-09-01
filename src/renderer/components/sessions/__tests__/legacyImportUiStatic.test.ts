import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../SessionManagerView.tsx'), 'utf8');

describe('legacy import UI contract', () => {
  it('starts with no selected sessions and requires explicit checkbox selection', () => {
    expect(source).toContain('useState<Set<string>>(() => new Set())');
    expect(source).toContain('onSelectedChange={(selected) => setSelected(session.id, selected)}');
    expect(source).toContain('全选当前项目');
    expect(source).toContain('disabled={selectedSessionIds.size === 0');
  });

  it('reports each result and only opens through an explicit button', () => {
    expect(source).toContain('setReport(result.results)');
    expect(source).toContain('导入完成后不会自动打开会话');
    expect(source).toContain('onClick={() => onOpenImported?.(item.session');
    expect(source).not.toContain('onOpenImported?.(result');
  });

  it('uses accurate Pi continuation wording instead of Claude resume wording', () => {
    expect(source).toContain('只读复制历史，并在 Pi 中继续');
    expect(source).not.toContain('恢复 Claude');
    expect(source).not.toContain('Resume Claude');
  });
});
