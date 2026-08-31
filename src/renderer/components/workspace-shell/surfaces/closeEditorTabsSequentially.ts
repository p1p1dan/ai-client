export type CloseEditorTabResult = 'closed' | 'cancelled' | 'failed';

/**
 * Run batch tab closes in visible order and stop at the first cancellation or
 * failed save. This prevents “Close All/Others/Left/Right” from discarding
 * later dirty tabs after the user has explicitly cancelled one prompt.
 */
export async function closeEditorTabsSequentially(
  paths: readonly string[],
  closeOne: (path: string) => Promise<CloseEditorTabResult>
): Promise<CloseEditorTabResult> {
  for (const path of paths) {
    const result = await closeOne(path);
    if (result !== 'closed') return result;
  }
  return 'closed';
}
