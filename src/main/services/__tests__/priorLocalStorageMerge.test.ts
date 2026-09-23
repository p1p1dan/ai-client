import { describe, expect, it } from 'vitest';
import {
  planLocalStorageMerge,
  REPOSITORIES_STORAGE_KEY,
  REPOSITORY_GROUPS_STORAGE_KEY,
} from '../priorLocalStorageMerge';

/**
 * A test.17+ machine already has its own `Local Storage`, so the old repository
 * list can only arrive key by key. Without it the migrated conversations stay
 * invisible: the sidebar draws them under their repository.
 */
describe('prior localStorage merge plan', () => {
  const repos = (...paths: string[]) =>
    JSON.stringify(paths.map((path) => ({ path, name: path.split(/[\\/]/).pop() })));

  it('writes every key the new store does not have (v0.3.4 store into an empty one)', () => {
    const prior = { [REPOSITORIES_STORAGE_KEY]: repos('E:\\a'), 'aiclient-selected-repo': 'E:\\a' };

    const plan = planLocalStorageMerge({}, [prior]);

    expect(plan.writes).toEqual(prior);
    expect(plan.addedKeys).toBe(2);
  });

  it('appends only the repositories the new list does not name, keeping its own rows first', () => {
    const current = { [REPOSITORIES_STORAGE_KEY]: repos('E:\\Code\\new-only', 'E:\\Code\\shared') };
    const prior = {
      [REPOSITORIES_STORAGE_KEY]: repos('e:/code/SHARED/', 'E:\\Code\\old-only'),
    };

    const plan = planLocalStorageMerge(current, [prior]);

    expect(JSON.parse(plan.writes[REPOSITORIES_STORAGE_KEY] ?? '[]')).toEqual([
      { path: 'E:\\Code\\new-only', name: 'new-only' },
      { path: 'E:\\Code\\shared', name: 'shared' },
      { path: 'E:\\Code\\old-only', name: 'old-only' },
    ]);
    expect(plan.addedRepositories).toBe(1);
  });

  it('treats an empty new list as a list, and fills it', () => {
    const plan = planLocalStorageMerge({ [REPOSITORIES_STORAGE_KEY]: '[]' }, [
      { [REPOSITORIES_STORAGE_KEY]: repos('E:\\a', 'E:\\b') },
    ]);
    expect(plan.addedRepositories).toBe(2);
  });

  it('unions groups by id so appended repositories keep their group', () => {
    const current = {
      [REPOSITORY_GROUPS_STORAGE_KEY]: JSON.stringify([{ id: 'g1', name: 'new' }]),
    };
    const prior = {
      [REPOSITORY_GROUPS_STORAGE_KEY]: JSON.stringify([
        { id: 'g1', name: 'old' },
        { id: 'g2', name: 'old' },
      ]),
    };

    const plan = planLocalStorageMerge(current, [prior]);

    expect(JSON.parse(plan.writes[REPOSITORY_GROUPS_STORAGE_KEY] ?? '[]')).toEqual([
      { id: 'g1', name: 'new' },
      { id: 'g2', name: 'old' },
    ]);
    expect(plan.addedGroups).toBe(1);
  });

  it('never overwrites a plain key the new store already has', () => {
    const plan = planLocalStorageMerge({ 'aiclient-selected-repo': 'E:\\new' }, [
      { 'aiclient-selected-repo': 'E:\\old' },
    ]);
    expect(plan.writes).toEqual({});
  });

  it('leaves a new list it cannot parse alone', () => {
    const plan = planLocalStorageMerge({ [REPOSITORIES_STORAGE_KEY]: '{not json' }, [
      { [REPOSITORIES_STORAGE_KEY]: repos('E:\\a') },
    ]);
    expect(plan.writes).toEqual({});
  });

  it('lets the newest earlier store win, and plans nothing on a second pass', () => {
    const newer = { 'aiclient-selected-repo': 'newer', [REPOSITORIES_STORAGE_KEY]: repos('E:\\a') };
    const older = {
      'aiclient-selected-repo': 'older',
      [REPOSITORIES_STORAGE_KEY]: repos('E:\\a', 'E:\\b'),
    };

    const first = planLocalStorageMerge({}, [newer, older]);
    expect(first.writes['aiclient-selected-repo']).toBe('newer');
    expect(JSON.parse(first.writes[REPOSITORIES_STORAGE_KEY] ?? '[]')).toHaveLength(2);

    const second = planLocalStorageMerge(first.writes, [newer, older]);
    expect(second.writes).toEqual({});
  });

  it('is not fooled by keys that shadow Object.prototype', () => {
    const plan = planLocalStorageMerge({}, [{ constructor: 'x', __proto__: 'y' } as never]);
    expect(plan.writes.constructor).toBe('x');
  });
});
