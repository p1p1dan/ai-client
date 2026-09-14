import { describe, expect, it } from 'vitest';
import {
  isLegacyImportBatchRequest,
  isWorkerImportConversationPayload,
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

  // import-catalog-07: targetPiSessionId is joined straight into a session
  // file path by the worker (NativeLegacyImportWriter.fileFor); a bare
  // non-empty check let a path-traversal id through the RPC boundary.
  it('rejects a targetPiSessionId that is not a safe path segment', () => {
    expect(
      isWorkerImportConversationPayload({
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-1',
        conversation: validConversation,
      })
    ).toBe(true);
    for (const targetPiSessionId of ['', '   ', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b']) {
      expect(
        isWorkerImportConversationPayload({
          logicalSessionId: 'logical-1',
          targetPiSessionId,
          conversation: validConversation,
        }),
        targetPiSessionId
      ).toBe(false);
    }
  });
});
