import { describe, expect, it } from 'vitest';
import { isLegacyImportBatchRequest, LEGACY_IMPORT_MAX_BATCH } from '../legacyImport';

describe('legacy import boundary guards', () => {
  it('accepts a bounded Claude source batch', () => {
    expect(
      isLegacyImportBatchRequest({
        sources: [{ sourceKind: 'claude-code', projectId: 'project', sourceSessionId: 'session' }],
      })
    ).toBe(true);
  });

  it('rejects null, malformed, unsupported, empty, and oversized batches', () => {
    for (const value of [
      null,
      {},
      { sources: [] },
      { sources: [null] },
      { sources: [{}] },
      { sources: [{ sourceKind: 'claude-code', projectId: '../tmp', sourceSessionId: 's' }] },
      { sources: [{ sourceKind: 'claude-code', projectId: 'p\\escape', sourceSessionId: 's' }] },
      { sources: [{ sourceKind: 'claude-code', projectId: 'p', sourceSessionId: '../s' }] },
      { sources: [{ sourceKind: 'codex', projectId: 'p', sourceSessionId: 's' }] },
      {
        sources: Array.from({ length: LEGACY_IMPORT_MAX_BATCH + 1 }, () => ({
          sourceKind: 'claude-code',
          projectId: 'p',
          sourceSessionId: 's',
        })),
      },
    ]) {
      expect(isLegacyImportBatchRequest(value), JSON.stringify(value)?.slice(0, 200)).toBe(false);
    }
  });
});
