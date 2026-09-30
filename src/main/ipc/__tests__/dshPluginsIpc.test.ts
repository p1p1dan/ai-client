import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshPluginCatalogEntry, DshPluginsState } from '@shared/dshPluginSettings';
import type { DshPluginReport } from '@shared/dshPlugins';
import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-10c (decisions 108 rule 7, 110, 117) — the two plugin
 * channels. The merge rules are pinned in `services/dshPlugins/__tests__`;
 * this pins what the IPC layer adds: the user's choice and the host's state
 * go only through the three calls of `dshHostPlugins.ts`, a switch writes one
 * override and keeps the rest, and a bad request writes nothing.
 */

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();

function entry(name: string, defaultEnabled = false): DshPluginCatalogEntry {
  return {
    name,
    version: '1.0.4',
    kind: 'internal',
    defaultEnabled,
    description: '',
    readTools: ['word_read'],
    writeTools: ['word_create'],
    askTools: [],
    unlistedToolsAsk: false,
    review: { date: '2026-09-28', verdict: 'conditional' },
  };
}

const state = vi.hoisted(() => ({
  catalog: { plugins: [] as unknown[], error: null as string | null },
  selection: undefined as Record<string, boolean> | undefined,
  report: undefined as unknown,
}));

const getDshPluginSelection = vi.fn(() => state.selection);
const setDshPluginSelection = vi.fn((overrides: Record<string, boolean> | undefined) => {
  state.selection = overrides;
  return true;
});
const getDshPluginReport = vi.fn(() => state.report as DshPluginReport | undefined);
/** P1-7e e5: who listens for a host start's new report (the IPC module, once). */
const reportListeners = new Set<() => void>();
const onDshPluginReport = vi.fn((listener: () => void) => {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
});

/** Stand-ins for the app's windows; the push goes to each one that is not destroyed. */
const windows = vi.hoisted(() => ({
  list: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { send: (...args: unknown[]) => void };
  }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  BrowserWindow: { getAllWindows: () => windows.list },
}));
vi.mock('../../services/agent-host/dshHostPlugins', () => ({
  getDshPluginSelection,
  setDshPluginSelection,
  getDshPluginReport,
  onDshPluginReport,
}));
vi.mock('../../services/dshPlugins/pluginCatalog', () => ({
  readCurrentDshPluginCatalog: () => state.catalog,
}));

const { registerDshPluginHandlers } = await import('../dshPlugins');
registerDshPluginHandlers();

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

async function list(): Promise<DshPluginsState> {
  return (await handler(IPC_CHANNELS.DSH_PLUGINS_LIST)({})) as DshPluginsState;
}

async function setEnabled(payload: unknown): Promise<DshPluginsState> {
  return (await handler(IPC_CHANNELS.DSH_PLUGINS_SET_ENABLED)({}, payload)) as DshPluginsState;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.catalog = { plugins: [entry('dsh-office-tools'), entry('dsh-other', true)], error: null };
  state.selection = undefined;
  state.report = undefined;
});

describe('dshPlugins:list', () => {
  it('merges the catalog, the overrides and the last host report', async () => {
    state.selection = { 'dsh-office-tools': true, 'dsh-delisted': true };
    state.report = {
      enabledFrom: 'main',
      plugins: [
        { name: 'dsh-office-tools', version: '1.0.4', defaultEnabled: false, state: 'disabled' },
        {
          name: 'dsh-other',
          version: '1.0.4',
          defaultEnabled: true,
          state: 'missing',
          reason: 'not in the install directory',
        },
      ],
      dropped: [{ name: 'dsh-delisted', reason: 'not on the allowlist' }],
    } satisfies DshPluginReport;

    const view = await list();
    expect(
      view.plugins.map((p) => ({
        name: p.name,
        enabled: p.enabled,
        overridden: p.overridden,
        host: p.host,
        pendingRestart: p.pendingRestart,
        writeTools: p.writeTools,
        review: p.review,
      }))
    ).toEqual([
      {
        name: 'dsh-office-tools',
        enabled: true,
        overridden: true,
        host: { state: 'disabled' },
        pendingRestart: true,
        writeTools: ['word_create'],
        review: { date: '2026-09-28', verdict: 'conditional' },
      },
      {
        name: 'dsh-other',
        enabled: true,
        overridden: false,
        host: { state: 'missing', reason: 'not in the install directory' },
        pendingRestart: false,
        writeTools: ['word_create'],
        review: { date: '2026-09-28', verdict: 'conditional' },
      },
    ]);
    expect(view.delisted).toEqual([{ name: 'dsh-delisted', reason: 'not on the allowlist' }]);
    expect(view).toMatchObject({ hostReported: true, selectionInvalid: false, catalogError: null });
  });

  it('only reads', async () => {
    await list();
    expect(getDshPluginSelection).toHaveBeenCalledTimes(1);
    expect(getDshPluginReport).toHaveBeenCalledTimes(1);
    expect(setDshPluginSelection).not.toHaveBeenCalled();
  });

  it('passes on a catalog that could not be read', async () => {
    state.catalog = { plugins: [], error: 'allowlist.json is unreadable' };
    expect(await list()).toMatchObject({
      plugins: [],
      catalogError: 'allowlist.json is unreadable',
    });
  });
});

describe('dshPlugins:setEnabled', () => {
  it('stores one override through setDshPluginSelection and answers with the new state', async () => {
    const view = await setEnabled({ name: 'dsh-office-tools', enabled: true });
    expect(setDshPluginSelection).toHaveBeenCalledExactlyOnceWith({ 'dsh-office-tools': true });
    expect(view.plugins[0]).toMatchObject({ name: 'dsh-office-tools', enabled: true });
  });

  it('keeps every other override, delisted names included', async () => {
    state.selection = { 'dsh-other': false, 'dsh-delisted': true };
    await setEnabled({ name: 'dsh-office-tools', enabled: false });
    expect(setDshPluginSelection).toHaveBeenCalledExactlyOnceWith({
      'dsh-other': false,
      'dsh-delisted': true,
      'dsh-office-tools': false,
    });
  });

  it('records switching a plugin to its default as an override, not as "untouched"', async () => {
    await setEnabled({ name: 'dsh-other', enabled: true });
    expect(setDshPluginSelection).toHaveBeenCalledExactlyOnceWith({ 'dsh-other': true });
  });

  it.each([
    ['no payload', undefined],
    ['a string', 'dsh-office-tools'],
    ['an array', ['dsh-office-tools', true]],
    ['no name', { enabled: true }],
    ['an empty name', { name: '', enabled: true }],
    ['a numeric name', { name: 7, enabled: true }],
    ['a string for enabled', { name: 'dsh-office-tools', enabled: 'true' }],
    ['no enabled', { name: 'dsh-office-tools' }],
    ['a name this build does not ship', { name: 'dsh-delisted', enabled: true }],
    ['a product row', { name: '@aiclient/dsh-app', enabled: false }],
  ])('refuses %s and writes nothing', async (_label, payload) => {
    await expect(setEnabled(payload)).rejects.toThrow(/Invalid plugin request/);
    expect(setDshPluginSelection).not.toHaveBeenCalled();
  });

  it('refuses every name while the catalog cannot be read', async () => {
    state.catalog = { plugins: [], error: 'allowlist.json is unreadable' };
    await expect(setEnabled({ name: 'dsh-office-tools', enabled: true })).rejects.toThrow(
      /not an available plugin/
    );
    expect(setDshPluginSelection).not.toHaveBeenCalled();
  });
});

/**
 * P1-7e e5 (problem 29, decision 143): an open plugins page follows the
 * engine. After each host start that replaced the report, Main sends the
 * page's whole new state to every window; nothing is written or restarted.
 */
describe('dshPlugins:changed', () => {
  function fakeWindow(destroyed = false) {
    return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
  }

  it('subscribes once, at registration', () => {
    expect(reportListeners.size).toBe(1);
  });

  it('sends the new state to every live window after a host start', () => {
    const live = fakeWindow();
    const gone = fakeWindow(true);
    windows.list = [live, gone];
    state.selection = { 'dsh-office-tools': true };
    state.report = {
      enabledFrom: 'main',
      plugins: [
        { name: 'dsh-office-tools', version: '1.0.4', defaultEnabled: false, state: 'loaded' },
      ],
      dropped: [],
    } satisfies DshPluginReport;
    for (const listener of reportListeners) listener();
    expect(live.webContents.send).toHaveBeenCalledTimes(1);
    const [channel, pushed] = live.webContents.send.mock.calls[0] as [string, DshPluginsState];
    expect(channel).toBe(IPC_CHANNELS.DSH_PLUGINS_CHANGED);
    expect(pushed).toMatchObject({ hostReported: true });
    expect(pushed.plugins[0]).toMatchObject({
      name: 'dsh-office-tools',
      enabled: true,
      host: { state: 'loaded' },
      pendingRestart: false,
    });
    expect(gone.webContents.send).not.toHaveBeenCalled();
    expect(setDshPluginSelection).not.toHaveBeenCalled();
    windows.list = [];
  });

  it('sends nothing when the state cannot be read, and does not throw into the host', () => {
    const live = fakeWindow();
    windows.list = [live];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getDshPluginSelection.mockImplementationOnce(() => {
      throw new Error('settings unreadable');
    });
    expect(() => {
      for (const listener of reportListeners) listener();
    }).not.toThrow();
    expect(live.webContents.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    windows.list = [];
  });
});

describe('what the IPC module reaches', () => {
  const sourcePath = join(__dirname, '..', 'dshPlugins.ts');
  // Comments may name what the module deliberately does not touch.
  const source = readFileSync(sourcePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // P1-7e e5 (decision 143): a fourth call, `onDshPluginReport`, to follow
  // the report after a host start. It only reads; the next test still pins
  // that nothing here writes the selection or restarts the host.
  it('imports exactly the calls of dshHostPlugins.ts from agent-host, and nothing else there', () => {
    const agentHostImports = [
      ...source.matchAll(/from '\.\.\/services\/agent-host\/([^']+)'/g),
    ].map((match) => match[1]);
    expect(agentHostImports).toEqual(['dshHostPlugins']);
    const named = source.match(
      /import \{([^}]+)\} from '\.\.\/services\/agent-host\/dshHostPlugins'/
    )?.[1];
    expect(
      named
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort()
    ).toEqual([
      'getDshPluginReport',
      'getDshPluginSelection',
      'onDshPluginReport',
      'setDshPluginSelection',
    ]);
  });

  it('writes no settings of its own and restarts nothing itself', () => {
    for (const forbidden of [
      'writeDshPluginSelection',
      'writeSharedSettings',
      'mergeSettingsPatch',
      'invalidateAll',
      'reconcileHostPlugins',
      'workerManager',
      'dshHostSupervisor',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
