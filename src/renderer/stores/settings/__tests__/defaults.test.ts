import { describe, expect, it } from 'vitest';
import {
  defaultFileTreeDisplayMode,
  defaultLayoutMode,
  defaultRepositoryListDisplayMode,
} from '../defaults';

describe('settings defaults', () => {
  it('uses tree layout with split file tree and list repository view by default', () => {
    expect(defaultLayoutMode).toBe('tree');
    expect(defaultFileTreeDisplayMode).toBe('current');
    expect(defaultRepositoryListDisplayMode).toBe('list');
  });
});
