import { describe, expect, it } from 'vitest';
import { orderFoldersByAddedAt } from '../../components/workspace-shell/sidebarTree';
import { stampAddedAt } from '../storage';

// S-6 feedback 12 (issue #15): a repository added from the add dialog sorted below every
// older one in 「按工作目录」 until the next launch, because that path wrote no stamp.
describe('stampAddedAt', () => {
  it('stamps the add time and keeps every other field', () => {
    const repo = stampAddedAt({ id: 'r', name: 'r', path: '/r', kind: 'local' as const }, 42);
    expect(repo).toEqual({ id: 'r', name: 'r', path: '/r', kind: 'local', addedAt: 42 });
  });

  it('a just-added repository sorts above repositories backfilled at launch', () => {
    const launch = 1_000_000;
    // The load-time backfill spaces stamps by index from one "now".
    const stamps = new Map([
      ['a', launch - 3],
      ['b', launch - 2],
      ['c', launch - 1],
    ]);
    const added = stampAddedAt({ projectId: 'new' }, launch + 5000);
    stamps.set('new', added.addedAt);
    const folders = [{ projectId: 'a' }, { projectId: 'b' }, { projectId: 'c' }, added];
    expect(orderFoldersByAddedAt(folders, stamps).map((f) => f.projectId)).toEqual([
      'new',
      'c',
      'b',
      'a',
    ]);
  });
});
