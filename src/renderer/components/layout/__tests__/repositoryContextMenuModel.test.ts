import { describe, expect, it } from 'vitest';
import {
  buildRepositoryContextMenuModel,
  getEnabledRepositoryMenuAgents,
} from '../repositoryContextMenuModel';

describe('repositoryContextMenuModel', () => {
  it('exposes only the bundled Pi TUI action', () => {
    expect(getEnabledRepositoryMenuAgents()).toEqual([{ agentId: 'pi', label: 'Pi' }]);
  });

  it('builds repository actions without legacy CLI settings', () => {
    const model = buildRepositoryContextMenuModel({ t: (key) => key });
    expect(model.agentActions).toEqual([{ agentId: 'pi', label: 'Pi' }]);
    expect(model.primaryActions.map((action) => action.key)).toEqual([
      'open-folder',
      'copy-path',
      'open-terminal',
    ]);
    expect(model.destructiveAction.key).toBe('remove-repository');
  });
});
