import { describe, expect, it, vi } from 'vitest';
import { closeEditorTabsSequentially } from '../closeEditorTabsSequentially';

describe('closeEditorTabsSequentially', () => {
  it('closes every requested tab in visible order', async () => {
    const closeOne = vi.fn<(path: string) => Promise<'closed'>>(async () => 'closed');
    await expect(closeEditorTabsSequentially(['a', 'b', 'c'], closeOne)).resolves.toBe('closed');
    expect(closeOne.mock.calls.map(([path]) => path)).toEqual(['a', 'b', 'c']);
  });

  it('stops immediately when a dirty-tab prompt is cancelled', async () => {
    const closeOne = vi
      .fn<(path: string) => Promise<'closed' | 'cancelled'>>()
      .mockResolvedValueOnce('closed')
      .mockResolvedValueOnce('cancelled')
      .mockResolvedValueOnce('closed');
    await expect(closeEditorTabsSequentially(['a', 'b', 'c'], closeOne)).resolves.toBe('cancelled');
    expect(closeOne.mock.calls.map(([path]) => path)).toEqual(['a', 'b']);
  });

  it('stops immediately when save-before-close fails', async () => {
    const closeOne = vi
      .fn<(path: string) => Promise<'failed' | 'closed'>>()
      .mockResolvedValueOnce('failed');
    await expect(closeEditorTabsSequentially(['a', 'b'], closeOne)).resolves.toBe('failed');
    expect(closeOne).toHaveBeenCalledTimes(1);
  });
});
