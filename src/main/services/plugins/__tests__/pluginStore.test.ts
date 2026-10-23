import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginStore } from '../pluginStore';
import { writeZip } from '../zipWriter';

let root: string;
let store: PluginStore;
const crypto = {
  available: () => true,
  encrypt: (text: string) => Buffer.from(`enc:${text}`).toString('base64'),
  decrypt: (text: string) => Buffer.from(text, 'base64').toString().replace(/^enc:/, ''),
};

const manifest = {
  schemaVersion: 1,
  id: 'pilab.sample',
  name: 'Sample',
  version: '0.1.0',
  apiVersion: 1,
  main: 'main.js',
  permissions: ['chat.read'],
  contributes: {
    settings: [
      { key: 'url', title: 'URL', type: 'string', default: 'http://127.0.0.1:8443' },
      { key: 'token', title: 'Token', type: 'string', secret: true },
      { key: 'on', title: 'On', type: 'boolean', default: false },
    ],
  },
};

function pack(files: Record<string, string | object>, name = 'p.pilabplug'): string {
  const file = path.join(root, name);
  writeFileSync(
    file,
    writeZip(
      Object.entries(files).map(([p, content]) => ({
        path: p,
        data: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
      }))
    )
  );
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'plugin-store-'));
  store = new PluginStore(path.join(root, 'plugins'), crypto, () => 1000);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('PluginStore', () => {
  it('[PLG-STORE] installs a package disabled, and lists it', () => {
    const installed = store.installPackage(pack({ 'manifest.json': manifest, 'main.js': 'x' }));
    expect(installed.enabled).toBe(false);
    expect(installed.manifest.id).toBe('pilab.sample');
    expect(readFileSync(path.join(installed.dir, 'main.js'), 'utf8')).toBe('x');
    expect(existsSync(installed.dataDir)).toBe(true);
    expect(store.list().plugins.map((p) => p.manifest.id)).toEqual(['pilab.sample']);
  });

  it('[PLG-STORE] unwraps a package zipped with its folder', () => {
    const installed = store.installPackage(
      pack({ 'sample/manifest.json': manifest, 'sample/main.js': 'x' })
    );
    expect(existsSync(path.join(installed.dir, 'main.js'))).toBe(true);
  });

  it('[PLG-STORE] an update replaces the files and keeps enabled and data', () => {
    store.installPackage(pack({ 'manifest.json': manifest, 'main.js': 'v1', 'old.js': 'gone' }));
    store.setEnabled('pilab.sample', true);
    writeFileSync(path.join(store.dataDir('pilab.sample'), 'kept'), 'yes');
    const updated = store.installPackage(
      pack({ 'manifest.json': { ...manifest, version: '0.2.0' }, 'main.js': 'v2' })
    );
    expect(updated.enabled).toBe(true);
    expect(updated.manifest.version).toBe('0.2.0');
    expect(existsSync(path.join(updated.dir, 'old.js'))).toBe(false);
    expect(readFileSync(path.join(updated.dataDir, 'kept'), 'utf8')).toBe('yes');
  });

  it.each([
    ['no manifest', { 'main.js': 'x' }, /no manifest.json/],
    ['a bad manifest', { 'manifest.json': { ...manifest, id: 'Bad' }, 'main.js': 'x' }, /id/],
    ['a missing main', { 'manifest.json': manifest }, /main main.js is not in the package/],
    ['non-JSON manifest', { 'manifest.json': '{nope', 'main.js': 'x' }, /not JSON/],
  ])('[PLG-STORE] refuses a package with %s, installing nothing', (_label, files, error) => {
    expect(() => store.installPackage(pack(files as Record<string, string>))).toThrow(error);
    expect(store.list().plugins).toEqual([]);
  });

  it('[PLG-STORE] settings take defaults, keep secrets encrypted on disk, and validate types', () => {
    const { manifest: m } = store.installPackage(
      pack({ 'manifest.json': manifest, 'main.js': 'x' })
    );
    expect(store.readSettings(m)).toEqual({
      url: 'http://127.0.0.1:8443',
      token: undefined,
      on: false,
    });
    store.writeSetting(m, 'token', 's3cret');
    store.writeSetting(m, 'on', true);
    expect(store.readSettings(m)).toMatchObject({ token: 's3cret', on: true });
    const onDisk = readFileSync(
      path.join(root, 'plugins', 'settings', 'pilab.sample.json'),
      'utf8'
    );
    expect(onDisk).not.toContain('s3cret');
    expect(store.settingsView(m).find((v) => v.setting.key === 'token')?.value).toBe(true);
    expect(() => store.writeSetting(m, 'on', 'yes')).toThrow(/plugin_setting_invalid/);
    expect(() => store.writeSetting(m, 'nope', 1)).toThrow(/plugin_setting_unknown/);
    store.writeSetting(m, 'token', null);
    expect(store.readSettings(m).token).toBeUndefined();
  });

  it('[PLG-STORE] uninstall removes files, data, settings and state', () => {
    const { manifest: m } = store.installPackage(
      pack({ 'manifest.json': manifest, 'main.js': 'x' })
    );
    store.writeSetting(m, 'url', 'http://x');
    store.uninstall('pilab.sample');
    expect(store.list().plugins).toEqual([]);
    expect(existsSync(store.dataDir('pilab.sample'))).toBe(false);
    expect(existsSync(path.join(root, 'plugins', 'settings', 'pilab.sample.json'))).toBe(false);
  });
});
