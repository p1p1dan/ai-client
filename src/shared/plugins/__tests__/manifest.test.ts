import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, parsePluginManifest } from '../manifest';

const base = {
  schemaVersion: 1,
  id: 'pilab.remote-access',
  name: 'Remote access',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION,
  main: 'dist/main.js',
};

describe('plugin manifest v1', () => {
  it('[PLG-MANIFEST] fills defaults for a minimal manifest', () => {
    const result = parsePluginManifest(base);
    expect(result).toEqual({
      ok: true,
      manifest: { ...base, permissions: [], contributes: { settings: [], services: [] } },
    });
  });

  it('[PLG-MANIFEST] accepts settings, services, permissions and net hosts', () => {
    const result = parsePluginManifest({
      ...base,
      permissions: ['chat.read', 'chat.control'],
      net: { hosts: ['203.0.113.7:8443'] },
      contributes: {
        settings: [
          { key: 'relayUrl', title: 'Relay', type: 'string' },
          { key: 'token', title: 'Token', type: 'string', secret: true },
          { key: 'mode', title: 'Mode', type: 'select', options: [{ label: 'A', value: 'a' }] },
        ],
        services: [{ id: 'connector' }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a bad id', { id: 'NoDots' }, 'id'],
    ['an unknown permission', { permissions: ['fs.write'] }, 'permissions'],
    ['a main outside the package', { main: '../evil.js' }, 'main'],
    ['an absolute main', { main: '/etc/passwd' }, 'main'],
    ['a Windows drive main', { main: 'C:/x.js' }, 'main'],
    ['a non-semver version', { version: '1.0' }, 'version'],
  ])('[PLG-MANIFEST] refuses %s', (_label, patch, field) => {
    const result = parsePluginManifest({ ...base, ...patch });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(field);
  });

  it('[PLG-MANIFEST] refuses another host API version', () => {
    const result = parsePluginManifest({ ...base, apiVersion: PLUGIN_API_VERSION + 1 });
    expect(!result.ok && result.error).toMatch(/host API/);
  });

  it('[PLG-MANIFEST] refuses duplicate setting keys, too many services, select without options', () => {
    const dupe = parsePluginManifest({
      ...base,
      contributes: {
        settings: [
          { key: 'a', title: 'A', type: 'string' },
          { key: 'a', title: 'A', type: 'string' },
        ],
      },
    });
    expect(!dupe.ok && dupe.error).toMatch(/duplicate setting key/);
    const many = parsePluginManifest({
      ...base,
      contributes: { services: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) },
    });
    expect(many.ok).toBe(false);
    const select = parsePluginManifest({
      ...base,
      contributes: { settings: [{ key: 'm', title: 'M', type: 'select' }] },
    });
    expect(select.ok).toBe(false);
  });
});
