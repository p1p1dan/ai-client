import { IPC_CHANNELS, LEGACY_IMPORT_MAX_BATCH } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const listProjects = vi.fn(async () => []);
const listSessions = vi.fn(async () => []);
const importBatch = vi.fn(async () => ({ results: [] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
}));
vi.mock('../../services/legacyImport/LegacyImportService', () => ({
  legacyImportService: {
    reconcile: vi.fn(async () => undefined),
    listProjects,
    listSessions,
    importBatch,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  vi.clearAllMocks();
  const { registerLegacyImportHandlers } = await import('../legacyImport');
  registerLegacyImportHandlers();
});

function invokeListSessions(projectId: unknown): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.LEGACY_IMPORT_LIST_SESSIONS);
  if (!handler) throw new Error('legacy import list handler missing');
  return Promise.resolve(handler({}, projectId));
}

function invokeBatch(payload: unknown): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.LEGACY_IMPORT_BATCH);
  if (!handler) throw new Error('legacy import handler missing');
  return Promise.resolve(handler({}, payload));
}

describe('legacy import IPC', () => {
  it('accepts a bounded validated source batch', async () => {
    const request = {
      sources: [{ sourceKind: 'claude-code', projectId: 'p', sourceSessionId: 's' }],
    };
    await expect(invokeBatch(request)).resolves.toEqual({ results: [] });
    expect(importBatch).toHaveBeenCalledWith(request.sources);
  });

  it('rejects project traversal before scanning the filesystem', async () => {
    for (const projectId of ['..', '../tmp', 'p/escape', 'p\\escape', '']) {
      await expect(invokeListSessions(projectId)).rejects.toThrow(
        'Invalid legacy import project id'
      );
    }
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('rejects null, malformed entries, and oversized arrays before the service', async () => {
    for (const payload of [
      null,
      { sources: [null] },
      { sources: [{}] },
      { sources: [{ sourceKind: 'claude-code', projectId: '../tmp', sourceSessionId: 's' }] },
      { sources: [{ sourceKind: 'claude-code', projectId: 'p', sourceSessionId: '../s' }] },
      {
        sources: Array.from({ length: LEGACY_IMPORT_MAX_BATCH + 1 }, () => ({
          sourceKind: 'claude-code',
          projectId: 'p',
          sourceSessionId: 's',
        })),
      },
    ]) {
      await expect(invokeBatch(payload)).rejects.toThrow('Invalid legacy import batch request');
    }
    expect(importBatch).not.toHaveBeenCalled();
  });
});
