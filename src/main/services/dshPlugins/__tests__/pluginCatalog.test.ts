import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-10c (decision 117) — the allowlist as Main reads it for the
 * settings page: the packaged manifest's `plugins` section, else the
 * checkout's `plugins/allowlist.json`, by the host's own rule.
 */

const electron = vi.hoisted(() => ({ isPackaged: false, appPath: '/app' }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
    getAppPath: () => electron.appPath,
    getPath: () => '/tmp',
  },
}));

const {
  catalogFromAllowlist,
  catalogFromManifest,
  currentDshHostDir,
  readDshPluginCatalog,
  toolAccessOf,
} = await import('../pluginCatalog');

const REPO = path.resolve(__dirname, '../../../../..');
const HOST_DIR = path.join(REPO, 'src', 'dsh-host');

function enoent(file: string): Error {
  return Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: 'ENOENT' });
}

/** A fake install tree: relative path under the host dir -> content. */
function files(tree: Record<string, string>) {
  return {
    hostDir: '/host',
    readText: (file: string) => {
      const rel = path.relative('/host', file).split(path.sep).join('/');
      if (!(rel in tree)) throw enoent(file);
      return tree[rel] as string;
    },
  };
}

const MANIFEST_ENTRY = {
  name: 'dsh-office-tools',
  version: '1.0.4',
  kind: 'internal',
  integrity: 'sha512-x',
  defaultEnabled: false,
  description: 'package description',
  display: { title: 'dsh-office-tools', description: 'locale description' },
  rows: ['dsh-office-tools'],
  tools: {
    word_read: { class: 'read', path: 'path' },
    word_create: { class: 'write', path: 'path' },
    excel_update: { class: 'write', path: 'path' },
  },
  review: {
    record: 'reviews/x.md',
    date: '2026-09-28',
    reviewer: 'someone',
    verdict: 'conditional',
  },
};

beforeEach(() => {
  electron.isPackaged = false;
  electron.appPath = '/app';
});

describe('toolAccessOf', () => {
  it('splits reads, writes and ask, and counts anything malformed as ask', () => {
    expect(
      toolAccessOf({
        z_write: { class: 'write', path: 'path' },
        a_write: { class: 'write', path: 'file' },
        read_it: { class: 'read', path: 'path' },
        ask_it: 'ask',
        odd: { class: 'delete', path: 'path' },
        '*': 'ask',
      })
    ).toEqual({
      readTools: ['read_it'],
      writeTools: ['a_write', 'z_write'],
      askTools: ['ask_it', 'odd'],
      unlistedToolsAsk: true,
    });
    expect(toolAccessOf(undefined)).toEqual({
      readTools: [],
      writeTools: [],
      askTools: [],
      unlistedToolsAsk: false,
    });
  });
});

describe('catalogFromManifest (packaged)', () => {
  it('takes the audited entries, preferring the locale description', () => {
    expect(catalogFromManifest([MANIFEST_ENTRY])).toEqual({
      plugins: [
        {
          name: 'dsh-office-tools',
          version: '1.0.4',
          kind: 'internal',
          defaultEnabled: false,
          description: 'locale description',
          readTools: ['word_read'],
          writeTools: ['excel_update', 'word_create'],
          askTools: [],
          unlistedToolsAsk: false,
          review: { date: '2026-09-28', verdict: 'conditional' },
        },
      ],
      error: null,
    });
  });

  it('leaves out malformed entries and later duplicates, as the host does', () => {
    const { plugins } = catalogFromManifest([
      MANIFEST_ENTRY,
      { ...MANIFEST_ENTRY, version: '9.9.9' },
      { ...MANIFEST_ENTRY, name: 'Not A Package' },
      { ...MANIFEST_ENTRY, name: 'dsh-x', kind: 'community' },
      { ...MANIFEST_ENTRY, name: 'dsh-y', defaultEnabled: 'yes' },
      'dsh-z',
    ]);
    expect(plugins.map((plugin) => `${plugin.name}@${plugin.version}`)).toEqual([
      'dsh-office-tools@1.0.4',
    ]);
  });

  it('keeps an entry whose review is unusable, without a review', () => {
    const { plugins } = catalogFromManifest([
      { ...MANIFEST_ENTRY, review: { date: 'yesterday', verdict: 'approved' } },
    ]);
    expect(plugins[0]?.review).toBeNull();
  });

  it('says so when the section is missing', () => {
    expect(catalogFromManifest(undefined)).toEqual({
      plugins: [],
      error: 'dsh-host-manifest.json has no plugins section',
    });
  });
});

describe('catalogFromAllowlist (checkout)', () => {
  it('reads the committed allowlist by the build’s rules', () => {
    const raw = JSON.parse(readFileSync(path.join(HOST_DIR, 'plugins', 'allowlist.json'), 'utf8'));
    const { plugins, error } = catalogFromAllowlist(raw, (name) => `about ${name}`);
    expect(error).toBeNull();
    const office = plugins.find((plugin) => plugin.name === 'dsh-office-tools');
    expect(office).toMatchObject({
      version: '1.0.4',
      kind: 'internal',
      defaultEnabled: false,
      description: 'about dsh-office-tools',
      readTools: ['excel_read', 'ppt_read', 'word_read'],
      writeTools: ['excel_create', 'excel_update', 'ppt_create', 'word_create', 'word_update'],
      review: { date: '2026-09-28', verdict: 'conditional' },
    });
  });

  it('drops the entries the allowlist schema rejects', () => {
    const raw = { schema: 1, plugins: [{ name: 'dsh-bad', version: 'latest' }] };
    expect(catalogFromAllowlist(raw, () => '').plugins).toEqual([]);
  });
});

describe('readDshPluginCatalog', () => {
  it('reads the manifest when the host is packaged', () => {
    const catalog = readDshPluginCatalog(
      files({
        'dsh-host-manifest.json': JSON.stringify({ schema: 1, plugins: [MANIFEST_ENTRY] }),
        'plugins/allowlist.json': '{"not": "read"}',
      })
    );
    expect(catalog.plugins.map((plugin) => plugin.name)).toEqual(['dsh-office-tools']);
  });

  it('falls back to the checkout allowlist, describing each installed package', () => {
    const allowlist = readFileSync(path.join(HOST_DIR, 'plugins', 'allowlist.json'), 'utf8');
    const catalog = readDshPluginCatalog(
      files({
        'plugins/allowlist.json': allowlist,
        'node_modules/dsh-office-tools/package.json': JSON.stringify({
          description: 'from package.json',
        }),
      })
    );
    expect(catalog.plugins[0]?.description).toBe('from package.json');

    const withLocale = readDshPluginCatalog(
      files({
        'plugins/allowlist.json': allowlist,
        'node_modules/dsh-office-tools/package.json': '{"description": "from package.json"}',
        'node_modules/dsh-office-tools/locale/en.json': '{"description": "from the locale"}',
      })
    );
    expect(withLocale.plugins[0]?.description).toBe('from the locale');

    const bare = readDshPluginCatalog(files({ 'plugins/allowlist.json': allowlist }));
    expect(bare.plugins[0]?.description).toBe('');
  });

  it('reports a list it cannot read instead of pretending it is empty', () => {
    expect(readDshPluginCatalog(files({})).error).toMatch(/allowlist\.json is unreadable/);
    expect(readDshPluginCatalog(files({ 'dsh-host-manifest.json': '{' })).error).toMatch(
      /dsh-host-manifest\.json is not valid JSON/
    );
    const denied = readDshPluginCatalog({
      hostDir: '/host',
      readText: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    });
    expect(denied).toMatchObject({ plugins: [], error: expect.stringMatching(/unreadable/) });
  });

  it('reads this checkout’s own host directory', () => {
    const catalog = readDshPluginCatalog({
      hostDir: HOST_DIR,
      readText: (file) => readFileSync(file, 'utf8'),
    });
    expect(catalog.error).toBeNull();
    expect(catalog.plugins.map((plugin) => plugin.name)).toContain('dsh-office-tools');
  });
});

describe('currentDshHostDir', () => {
  it('is the directory of the entry the host launch runs', () => {
    expect(currentDshHostDir()).toBe(path.join('/app', 'src', 'dsh-host'));
    electron.isPackaged = true;
    const resources = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { value: '/res', configurable: true });
    try {
      expect(currentDshHostDir()).toBe(path.join('/res', 'dsh-host'));
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    }
  });
});
