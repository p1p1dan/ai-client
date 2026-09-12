import { describe, expect, it } from 'vitest';
import {
  EXTENSION_INVENTORY_MAX,
  extensionDisplayName,
  readLoadedExtensionInventory,
} from '../extensionInventory.ts';

describe('extensionDisplayName', () => {
  it('names an extension after its directory, not its entry file', () => {
    expect(extensionDisplayName('/home/u/.pi/extensions/pi-mcp/index.js')).toBe('pi-mcp');
    expect(extensionDisplayName('/home/u/.pi/extensions/pi-mcp/extension.ts')).toBe('pi-mcp');
    expect(extensionDisplayName('C:\\Users\\u\\.pi\\ext\\thing\\main.mjs')).toBe('thing');
  });

  it('falls back to a bare file stem rather than a generic label', () => {
    // Five rows all reading "extension" would be worse than five odd names.
    expect(extensionDisplayName('/opt/plugins/linter.js')).toBe('linter');
    expect(extensionDisplayName('/opt/plugins/linter')).toBe('linter');
  });

  it('skips a build-layout directory instead of naming a plugin after it', () => {
    // The real path from the 2026-09-11 point-check: this rendered as `src`.
    expect(
      extensionDisplayName(
        '/home/u/src/agent-host/node_modules/@gotgenes/pi-permission-system/src/index.ts'
      )
    ).toBe('pi-permission-system');
    expect(extensionDisplayName('/opt/p/my-plugin/dist/index.js')).toBe('my-plugin');
    expect(extensionDisplayName('C:\\p\\my-plugin\\lib\\main.mjs')).toBe('my-plugin');
  });

  it('stops after one level up, so it cannot start naming plugins after node_modules', () => {
    // No package above the layout directory: the layout name is still better
    // than climbing into `node_modules` or a scope directory.
    expect(extensionDisplayName('/src/index.ts')).toBe('src');
  });
});

describe('readLoadedExtensionInventory (U04)', () => {
  it('reports loaded extensions with their source and scope', () => {
    expect(
      readLoadedExtensionInventory({
        extensions: [
          {
            path: 'pi-mcp',
            resolvedPath: '/home/u/.pi/extensions/pi-mcp/index.js',
            sourceInfo: { source: 'npm:pi-mcp', scope: 'user', origin: 'package' },
          },
        ],
      })
    ).toEqual([
      {
        name: 'pi-mcp',
        path: '/home/u/.pi/extensions/pi-mcp/index.js',
        source: 'npm:pi-mcp',
        scope: 'user',
        ok: true,
      },
    ]);
  });

  it('hides our own inline internals', () => {
    // The permission-activity observer and the tier authorizer are features the
    // user already sees elsewhere; listing them invites "how do I remove this".
    const result = readLoadedExtensionInventory({
      extensions: [
        { path: '/inline/aiclient-session-tier', hidden: true },
        { path: '/real/plugin/index.js' },
      ],
    });
    expect(result.map((entry) => entry.name)).toEqual(['plugin']);
  });

  it('lists a failed extension with its error — that is the one worth seeing', () => {
    const result = readLoadedExtensionInventory({
      errors: [{ path: '/home/u/.pi/extensions/broken/index.js', error: 'SyntaxError: bad' }],
    });
    expect(result).toEqual([
      {
        name: 'broken',
        path: '/home/u/.pi/extensions/broken/index.js',
        ok: false,
        error: 'SyntaxError: bad',
      },
    ]);
  });

  it('drops unreadable entries instead of throwing — a plugin list must never fail a bootstrap', () => {
    expect(
      readLoadedExtensionInventory({
        extensions: [null, 42, {}, { path: '   ' }, { path: '/ok/index.js' }] as never,
        errors: ['nope'] as never,
      }).map((entry) => entry.name)
    ).toEqual(['ok']);
  });

  it('returns an empty list for an SDK that reported nothing', () => {
    expect(readLoadedExtensionInventory(undefined)).toEqual([]);
    expect(readLoadedExtensionInventory({})).toEqual([]);
  });

  it('caps the list so a pathological config cannot flood the RPC', () => {
    const many = Array.from({ length: EXTENSION_INVENTORY_MAX + 10 }, (_, i) => ({
      path: `/ext/p${i}/index.js`,
    }));
    expect(readLoadedExtensionInventory({ extensions: many })).toHaveLength(
      EXTENSION_INVENTORY_MAX
    );
  });
});
