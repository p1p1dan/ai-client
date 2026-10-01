import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DshHostLayoutInput } from '../../agent-host/DshHostProcess';

const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  getAppPath: () => '/opt/app/resources/app.asar',
}));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/home/u/.pilab/profile' }));

/**
 * dsh-rebase P1-12 step 1 (decision 147): readiness is the DSH host's own
 * layout, never the retired native worker artifact. A packaged build without
 * `resources/agent-host` must still come up `ready` — that is the first-screen
 * regression this whole check exists to prevent (P1-12 risk R1).
 */
function layout(
  files: readonly string[],
  overrides: Partial<DshHostLayoutInput> = {}
): () => DshHostLayoutInput {
  const present = new Set(files);
  return () => ({
    isPackaged: true,
    appPath: '/opt/app/resources/app.asar',
    resourcesPath: '/opt/app/resources',
    platform: 'linux',
    env: {},
    exists: (file) => present.has(file),
    ...overrides,
  });
}

const PACKAGED_NODE = join('/opt/app/resources', 'node-runtime', 'node');
const PACKAGED_ENTRY = join('/opt/app/resources', 'dsh-host', 'host.js');

describe('PiRuntimeChecker (DSH host layout)', () => {
  it('reports ready for a packaged build that ships the DSH host and no agent-host', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const seen: string[] = [];
    const checker = new PiRuntimeChecker(() => ({
      ...layout([PACKAGED_NODE, PACKAGED_ENTRY])(),
      exists: (file) => {
        seen.push(file);
        return file === PACKAGED_NODE || file === PACKAGED_ENTRY;
      },
    }));
    await expect(checker.detect()).resolves.toEqual({ kind: 'ready', workerVersion: 'dsh-host' });
    expect(seen).toEqual([PACKAGED_NODE, PACKAGED_ENTRY]);
    expect(seen.some((file) => file.includes('agent-host'))).toBe(false);
  });

  it('reports unavailable when the bundled node or the host entry is missing', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    await expect(new PiRuntimeChecker(layout([PACKAGED_ENTRY])).detect()).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(new PiRuntimeChecker(layout([PACKAGED_NODE])).detect()).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('checks the Windows node.exe when packaged for win32', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const nodeExe = join('/opt/app/resources', 'node-runtime', 'node.exe');
    const checker = new PiRuntimeChecker(layout([nodeExe, PACKAGED_ENTRY], { platform: 'win32' }));
    await expect(checker.detect()).resolves.toMatchObject({ kind: 'ready' });
  });

  it('checks out-node-runtime and the host source when unpackaged', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const node = join('/repo', 'out-node-runtime', 'node');
    const entry = join('/repo', 'src', 'dsh-host', 'host.ts');
    const unpackaged = { isPackaged: false, appPath: '/repo' };
    await expect(
      new PiRuntimeChecker(layout([node, entry], unpackaged)).detect()
    ).resolves.toMatchObject({ kind: 'ready' });
    await expect(new PiRuntimeChecker(layout([entry], unpackaged)).detect()).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('caches the verdict until invalidated', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const exists = vi.fn(() => false);
    const checker = new PiRuntimeChecker(() => ({ ...layout([])(), exists }));
    await checker.detect();
    await checker.detect();
    expect(exists).toHaveBeenCalledTimes(1);
    expect(checker.getCached()).toEqual({ kind: 'unavailable' });
    checker.invalidate();
    expect(checker.getCached()).toBeNull();
    await checker.detect();
    expect(exists).toHaveBeenCalledTimes(2);
    await checker.detect(true);
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it('lets an unexpected failure escape as a detection failure, not a verdict', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const checker = new PiRuntimeChecker(() => ({
      ...layout([])(),
      exists: () => {
        throw new Error('EACCES');
      },
    }));
    await expect(checker.detect()).rejects.toThrow('EACCES');
    expect(checker.getCached()).toBeNull();
  });

  it('reads the running app by default', async () => {
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const original = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      value: '/definitely/not/installed',
      configurable: true,
    });
    try {
      await expect(new PiRuntimeChecker().detect()).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true });
    }
  });
});
