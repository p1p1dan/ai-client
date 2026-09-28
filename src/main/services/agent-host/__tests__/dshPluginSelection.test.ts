import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-10b (decisions 059 rule 4, 108 rule 5, 110) — the user's
 * per-plugin overrides in Main's shared settings, and Main's entry that
 * stores them and brings the host in line.
 */

const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, writes: 0 }));
vi.mock('../../SharedSessionState', () => ({
  readSharedSettings: () => store.settings,
  writeSharedSettings: (data: Record<string, unknown>) => {
    store.settings = data;
    store.writes += 1;
  },
}));
// dshHostPlugins.ts reaches both singletons only through its production deps.
vi.mock('../WorkerManager', () => ({ workerManager: { reconcileHostPlugins: vi.fn() } }));
vi.mock('../DshHostSupervisor', () => ({ dshHostSupervisor: { pluginReport: vi.fn() } }));

const { readDshPluginSelection, writeDshPluginSelection } = await import('../dshPluginSelection');
const { getDshPluginReport, getDshPluginSelection, setDshPluginSelection } = await import(
  '../dshHostPlugins'
);
const { workerManager } = await import('../WorkerManager');
const { dshHostSupervisor } = await import('../DshHostSupervisor');

beforeEach(() => {
  store.settings = { theme: 'dark', credentialMode: 'managed' };
  store.writes = 0;
  vi.mocked(workerManager.reconcileHostPlugins).mockClear();
});

describe('the stored selection', () => {
  it('is absent until someone touches a plugin: every plugin follows its default', () => {
    expect(readDshPluginSelection()).toBeUndefined();
    expect(readDshPluginSelection({ dshPlugins: { overrides: ['dsh-a'] } })).toBeUndefined();
  });

  it('stores the overrides under its Main-owned key, merged into the file', () => {
    expect(writeDshPluginSelection({ 'dsh-b': true, 'dsh-a': false })).toBe(true);
    expect(store.settings).toEqual({
      theme: 'dark',
      credentialMode: 'managed',
      dshPlugins: { overrides: { 'dsh-a': false, 'dsh-b': true } },
    });
    expect(readDshPluginSelection()).toEqual({ 'dsh-a': false, 'dsh-b': true });
  });

  it('writes nothing when nothing changed, and drops the key to go back to the defaults', () => {
    writeDshPluginSelection({ 'dsh-a': true });
    expect(writeDshPluginSelection({ 'dsh-a': true })).toBe(false);
    expect(store.writes).toBe(1);
    expect(writeDshPluginSelection(undefined)).toBe(true);
    expect(store.settings).toEqual({ theme: 'dark', credentialMode: 'managed' });
    expect(writeDshPluginSelection(undefined)).toBe(false);
  });

  it('keeps an empty object: nobody has touched anything, but Main still owns the decision', () => {
    writeDshPluginSelection({});
    expect(readDshPluginSelection()).toEqual({});
  });
});

describe("Main's entry (dshHostPlugins.ts)", () => {
  it('stores the overrides, then asks WorkerManager to restart a host that runs another set', () => {
    expect(setDshPluginSelection({ 'dsh-a': true })).toBe(true);
    expect(getDshPluginSelection()).toEqual({ 'dsh-a': true });
    expect(workerManager.reconcileHostPlugins).toHaveBeenCalledWith('{"dsh-a":true}');
    setDshPluginSelection(undefined);
    expect(workerManager.reconcileHostPlugins).toHaveBeenLastCalledWith('default');
  });

  it('reconciles even when the stored value did not change', () => {
    setDshPluginSelection({ 'dsh-a': true });
    expect(setDshPluginSelection({ 'dsh-a': true })).toBe(false);
    expect(workerManager.reconcileHostPlugins).toHaveBeenCalledTimes(2);
  });

  it("hands out the supervisor's latest report", () => {
    const report = { enabledFrom: 'default' as const, plugins: [], dropped: [] };
    vi.mocked(dshHostSupervisor.pluginReport).mockReturnValue(report);
    expect(getDshPluginReport()).toBe(report);
  });
});
