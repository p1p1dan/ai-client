/**
 * H/19 U4 — the plugin manager, with a fake pi CLI.
 *
 * The runner is stubbed because the real `pi install` reaches the npm registry;
 * `settings.json` is a real file on a temp dir, because the enable switch reads
 * and writes it and the thing worth proving is that it leaves everything else
 * in that file alone.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiPluginService, parsePiList } from '../PiPluginService';

const LIST_OUTPUT = `User packages:
  npm:pi-cc-extensions
    /agent/npm/node_modules/pi-cc-extensions
  npm:@gotgenes/pi-permission-system
    /agent/npm/node_modules/@gotgenes/pi-permission-system
`;

let agentDir: string;
let run: ReturnType<typeof vi.fn>;

function service(): PiPluginService {
  return new PiPluginService({ agentDir, runner: { run } });
}

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
}

function writeSettings(value: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(value, null, 2));
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'aiclient-plugins-'));
  run = vi.fn(async () => ({ ok: true, output: LIST_OUTPUT }));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('parsePiList', () => {
  it('pairs each source with the path indented under it', () => {
    expect(parsePiList(LIST_OUTPUT)).toEqual([
      { source: 'npm:pi-cc-extensions', path: '/agent/npm/node_modules/pi-cc-extensions' },
      {
        source: 'npm:@gotgenes/pi-permission-system',
        path: '/agent/npm/node_modules/@gotgenes/pi-permission-system',
      },
    ]);
  });

  it('ignores section headers, the empty-state line and an empty listing', () => {
    expect(parsePiList('User packages:\nProject packages:\n')).toEqual([]);
    expect(parsePiList('No packages installed.\n')).toEqual([]);
    expect(parsePiList('')).toEqual([]);
  });

  /**
   * Captured from a real run against a temp agent dir (2026-09-10): an entry
   * written as `{source, autoload:false}` lists with a ` (filtered)` note.
   * Without stripping it the source holds a space, validation rejects it, and
   * every DISABLED plugin disappears from the settings page — leaving no way to
   * turn one back on except editing the file by hand.
   */
  it('strips the annotation pi adds to a filtered entry', () => {
    expect(
      parsePiList(
        'User packages:\n  npm:pi-jingle (filtered)\n    /agent/npm/node_modules/pi-jingle\n'
      )
    ).toEqual([{ source: 'npm:pi-jingle', path: '/agent/npm/node_modules/pi-jingle' }]);
  });
});

describe('list', () => {
  it('reads installed packages from pi and their on/off state from settings', async () => {
    writeSettings({
      theme: 'dark',
      packages: [
        'npm:pi-cc-extensions',
        { source: 'npm:@gotgenes/pi-permission-system', autoload: false },
      ],
    });
    const plugins = await service().list();

    expect(run).toHaveBeenCalledWith(['list']);
    expect(plugins).toEqual([
      {
        source: 'npm:pi-cc-extensions',
        name: 'pi-cc-extensions',
        path: '/agent/npm/node_modules/pi-cc-extensions',
        enabled: true,
      },
      {
        source: 'npm:@gotgenes/pi-permission-system',
        name: '@gotgenes/pi-permission-system',
        path: '/agent/npm/node_modules/@gotgenes/pi-permission-system',
        enabled: false,
      },
    ]);
  });

  it('raises a failed listing instead of answering with an empty list', async () => {
    // An empty list reads as "you have no plugins", which is how someone ends
    // up reinstalling over a working set.
    run.mockResolvedValue({ ok: false, output: 'ENOENT: pi is missing' });
    await expect(service().list()).rejects.toThrow('ENOENT');
  });
});

describe('install / remove', () => {
  it('passes the source through to pi with no project-scope flag', async () => {
    run.mockResolvedValue({ ok: true, output: 'installed' });
    await service().install('  npm:pi-jingle  ');
    expect(run).toHaveBeenCalledWith(['install', 'npm:pi-jingle']);

    await service().remove('npm:pi-jingle');
    expect(run).toHaveBeenCalledWith(['remove', 'npm:pi-jingle']);
  });

  it('refuses a source that would be read as an option or reach a shell', async () => {
    for (const bad of ['--version', 'a; rm -rf /', 'a b', '', '`whoami`']) {
      const result = await service().install(bad);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('not usable');
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('setEnabled', () => {
  it('turns a package off by autoload flag, keeping it installed', () => {
    writeSettings({ theme: 'dark', packages: ['npm:pi-jingle'] });
    service().setEnabled('npm:pi-jingle', false);

    expect(settings()).toEqual({
      theme: 'dark',
      packages: [{ source: 'npm:pi-jingle', autoload: false }],
    });
  });

  it('turns it back on as the bare string it started as', () => {
    writeSettings({ packages: [{ source: 'npm:pi-jingle', autoload: false }] });
    service().setEnabled('npm:pi-jingle', true);
    expect(settings().packages).toEqual(['npm:pi-jingle']);
  });

  it('keeps a hand-written resource filter across a toggle', () => {
    // Collapsing this to a bare string would silently start loading resources
    // the user had deliberately filtered out.
    writeSettings({ packages: [{ source: 'npm:pi-jingle', skills: ['a'] }] });
    const instance = service();
    instance.setEnabled('npm:pi-jingle', false);
    expect(settings().packages).toEqual([
      { source: 'npm:pi-jingle', skills: ['a'], autoload: false },
    ]);
    instance.setEnabled('npm:pi-jingle', true);
    expect(settings().packages).toEqual([{ source: 'npm:pi-jingle', skills: ['a'] }]);
  });

  it('refuses a package that is not in the settings file', () => {
    writeSettings({ packages: [] });
    expect(() => service().setEnabled('npm:not-there', false)).toThrow('No installed plugin');
  });
});
