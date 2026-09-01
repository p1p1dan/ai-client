import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import { PiWorkerSession } from '../piWorkerSession.ts';

const GATED: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

function message(id: string, parentId: string | null, role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  };
}

describe('PiWorkerSession tree, rewind, and independent fork', () => {
  it('preserves descendants on rewind and creates a separate fork manager/file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiclient-t33-worker-'));
    const sourceFile = join(dir, 'source.jsonl');
    const forkFile = join(dir, 'fork.jsonl');
    const header = { type: 'session', version: 3, id: 'source-pi', cwd: '/repo' };
    const entries = [
      message('u-a', null, 'user', 'A'),
      message('a-a', 'u-a', 'assistant', 'A reply'),
      message('u-b', 'a-a', 'user', 'B'),
      message('a-b', 'u-b', 'assistant', 'B reply'),
      message('u-c', 'a-b', 'user', 'C'),
      message('a-c', 'u-c', 'assistant', 'C reply'),
    ];
    await writeFile(
      sourceFile,
      `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8'
    );

    let sourceLeaf: string | null = 'a-c';
    const branch = (leaf = sourceLeaf) => {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const path = [];
      let current = leaf ? byId.get(leaf) : undefined;
      while (current) {
        path.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return path.reverse();
    };
    const sourceManager = {
      getBranch: (fromId?: string) => branch(fromId ?? sourceLeaf),
      getCwd: () => '/repo',
      getSessionFile: () => sourceFile,
      getSessionId: () => 'source-pi',
      getEntries: () => [...entries],
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      getLeafId: () => sourceLeaf,
      getLabel: () => undefined,
      branch: (id: string) => {
        sourceLeaf = id;
      },
      resetLeaf: () => {
        sourceLeaf = null;
      },
      buildSessionContext: () => ({ messages: [] }),
    };
    const stagingManager = {
      ...sourceManager,
      createBranchedSession: (leafId: string) => {
        const selected = branch(leafId);
        writeFileSync(
          forkFile,
          `${JSON.stringify({ type: 'session', version: 3, id: 'fork-pi', cwd: '/repo', parentSession: sourceFile })}\n${selected.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
          'utf8'
        );
        return forkFile;
      },
    };
    const forkEntries = entries.slice(0, 2);
    const forkManager = {
      getBranch: () => forkEntries,
      getCwd: () => '/repo',
      getSessionFile: () => forkFile,
      getSessionId: () => 'fork-pi',
      getEntries: () => forkEntries,
      getEntry: (id: string) => forkEntries.find((entry) => entry.id === id),
      getLeafId: () => 'a-a',
      getLabel: () => undefined,
    };
    let openCount = 0;
    const liveSession = {
      sessionId: 'source-pi',
      sessionFile: sourceFile,
      model: { provider: 'glm', id: 'glm-5' },
      isStreaming: false,
      bindExtensions: async () => undefined,
      subscribe: () => () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      navigateTree: async (targetId: string) => {
        sourceLeaf = targetId;
        return { cancelled: false };
      },
    };
    const sdk = {
      getAgentDir: () => '/tmp/pi-agent',
      SessionManager: {
        create: () => sourceManager,
        open: (path: string) => {
          if (path === forkFile) return forkManager;
          openCount += 1;
          return openCount === 1 ? sourceManager : stagingManager;
        },
        continueRecent: () => sourceManager,
        inMemory: () => sourceManager,
      },
      SettingsManager: {
        create: () => ({
          getGlobalSettings: () => ({ packages: [] }),
          getProjectSettings: () => ({ packages: [] }),
        }),
      },
      createAgentSessionServices: async () => ({
        cwd: '/repo',
        agentDir: '/tmp/pi-agent',
        diagnostics: [],
        modelRuntime: { getModel: () => ({ provider: 'glm', id: 'glm-5' }) },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [{ path: '/bundle/pi-permission-system/src/index.ts' }],
          }),
        },
      }),
      createAgentSessionFromServices: async () => ({ session: liveSession }),
      createAgentSessionRuntime: async (
        factory: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
        options: Record<string, unknown>
      ) => factory({ cwd: options.cwd, sessionManager: options.sessionManager }),
    };
    const events: RuntimeEventDraft[] = [];
    const worker = new PiWorkerSession({
      logicalSessionId: 'logical-source',
      cwd: '/repo',
      sessionFile: sourceFile,
      projectTrusted: false,
      emit: (event) => events.push(event),
      loadSdk: async () => sdk,
      decidePermissionGate: () => GATED,
    });

    try {
      await worker.bootstrap();
      const before = await worker.tree({ logicalSessionId: 'logical-source' });
      expect(before.snapshot.nodes).toHaveLength(6);
      expect(before.snapshot.leaf.activeEntryId).toBe('a-c');
      expect(before.snapshot.nodes.find((node) => node.id === 'u-a')).toMatchObject({
        forkable: false,
      });
      expect(before.snapshot.nodes.find((node) => node.id === 'a-a')).toMatchObject({
        forkable: true,
      });
      await expect(
        worker.fork({ logicalSessionId: 'logical-source', entryId: 'u-a' })
      ).rejects.toMatchObject({ code: 'WORKER_FORK_PATH_NOT_MATERIALIZED' });

      const rewind = await worker.rewind({
        logicalSessionId: 'logical-source',
        targetEntryId: 'a-a',
        confirmed: true,
      });
      expect(rewind.leaf).toEqual({ activeEntryId: 'a-a', fileTailEntryId: 'a-c' });
      expect(rewind.tree.snapshot.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining(['u-b', 'a-b', 'u-c', 'a-c'])
      );
      expect((await readFile(sourceFile, 'utf8')).split('\n')).toHaveLength(8);

      const fork = await worker.fork({
        logicalSessionId: 'logical-source',
        entryId: 'a-a',
      });
      expect(fork).toMatchObject({
        sourceSessionFile: sourceFile,
        sessionFile: forkFile,
        piSessionId: 'fork-pi',
        leaf: { activeEntryId: 'a-a', fileTailEntryId: 'a-a' },
      });
      expect(sourceLeaf).toBe('a-a');
      expect(sourceManager.getEntries()).toHaveLength(6);
      expect(await readFile(forkFile, 'utf8')).toContain('"parentSession"');
    } finally {
      await worker.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
