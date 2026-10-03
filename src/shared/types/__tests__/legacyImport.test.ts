import { describe, expect, it } from 'vitest';
import {
  isImportedConversation,
  isLegacyImportBatchRequest,
  isLegacyImportPathSegment,
  LEGACY_IMPORT_MAX_BATCH,
} from '../legacyImport';

const validConversation = {
  schemaVersion: 1,
  importerVersion: 'test',
  sourceKind: 'claude-code' as const,
  stableSourceIdentity: 'id',
  sourceSessionId: 'session',
  workspacePath: '/repo',
  title: 't',
  sourceFingerprint: {
    stableSourceIdentity: 'id',
    contentHash: 'hash',
    size: 1,
    mode: 0o644,
    mtimeMs: 1,
  },
  entries: [{ kind: 'user' as const, text: 'hi' }],
  diagnostics: [],
};

describe('legacy import boundary guards', () => {
  it.each(['claude-code', 'codex'])('accepts a bounded %s source batch', (sourceKind) => {
    expect(
      isLegacyImportBatchRequest({
        sources: [{ sourceKind, projectId: 'project', sourceSessionId: 'session' }],
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
      { sources: [{ sourceKind: 'opencode', projectId: 'p', sourceSessionId: 's' }] },
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

  // import-catalog-07: a manifest's targetPiSessionId and a batch's project /
  // session ids are joined straight into file paths. The worker RPC guard that
  // also applied this check left with the native worker (dsh-rebase P1-12
  // step 3); the segment rule itself still guards Main's manifest and IPC.
  it('accepts only a safe single path segment', () => {
    expect(isLegacyImportPathSegment('import-1')).toBe(true);
    for (const segment of ['', '   ', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b']) {
      expect(isLegacyImportPathSegment(segment), segment).toBe(false);
    }
  });

  it('still recognises the imported conversation the host seeds a session from', () => {
    expect(isImportedConversation(validConversation)).toBe(true);
    expect(isImportedConversation({ ...validConversation, entries: [] })).toBe(false);
  });
});
