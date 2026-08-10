import { describe, expect, it } from 'vitest';
import { type DirectoryCheckItem, isDirectoryDrop } from '../useFileDrop';

function fileItem(entry: { isDirectory: boolean } | null): DirectoryCheckItem {
  return { webkitGetAsEntry: () => entry };
}

describe('isDirectoryDrop', () => {
  it('detects a dragged directory', () => {
    expect(isDirectoryDrop([fileItem({ isDirectory: true })])).toBe(true);
  });

  it('rejects a dragged file', () => {
    expect(isDirectoryDrop([fileItem({ isDirectory: false })])).toBe(false);
  });

  it('rejects when the entry cannot be resolved (non-native drag source)', () => {
    expect(isDirectoryDrop([fileItem(null)])).toBe(false);
  });

  it('rejects an empty or missing item list', () => {
    expect(isDirectoryDrop([])).toBe(false);
    expect(isDirectoryDrop(null)).toBe(false);
    expect(isDirectoryDrop(undefined)).toBe(false);
  });

  it('only looks at the first item', () => {
    expect(
      isDirectoryDrop([fileItem({ isDirectory: false }), fileItem({ isDirectory: true })])
    ).toBe(false);
  });
});
