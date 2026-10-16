import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isolatedLayout,
  parseProbeOutput,
  smokeLayout,
} from '../packaged-claude-sdk-host-smoke.mjs';

describe('isolatedLayout', () => {
  it('runs a copy under "PiLab Ai/resources", outside the checkout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sdk-smoke-test-'));
    try {
      const hostDir = path.join(tmp, 'app', 'resources', 'claude-sdk-host');
      const cli = path.join(hostDir, 'node_modules', '@anthropic-ai', 'cli', 'claude.exe');
      const node = path.join(tmp, 'app', 'resources', 'node-runtime', 'node.exe');
      for (const file of [path.join(hostDir, 'host.js'), cli, node]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'x');
      }
      const layout = { node, hostDir, entry: path.join(hostDir, 'host.js'), cli };
      const copy = isolatedLayout(layout, path.join(tmp, 'run'), { copyNode: true });
      const resources = path.join(tmp, 'run', 'PiLab Ai', 'resources');
      expect(copy.entry).toBe(path.join(resources, 'claude-sdk-host', 'host.js'));
      expect(copy.cli).toBe(
        path.join(
          resources,
          'claude-sdk-host',
          'node_modules',
          '@anthropic-ai',
          'cli',
          'claude.exe'
        )
      );
      expect(copy.node).toBe(path.join(resources, 'node-runtime', 'node.exe'));
      for (const file of [copy.entry, copy.cli, copy.node]) expect(fs.existsSync(file)).toBe(true);
      // This machine's node stays where it is.
      expect(isolatedLayout(layout, path.join(tmp, 'run2'), { copyNode: false }).node).toBe(node);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Route B S-4 (topic s4-packaging.md B-9): the packaged smoke drives the
 * packaged node, host.js and CLI, and passes only on the probe's own verdict.
 */

describe('smokeLayout', () => {
  it('takes the bundled node, host and CLI from an unpacked app', () => {
    const layout = smokeLayout({ appDir: path.join('/d', 'win-unpacked') }, 'win32', 'x64');
    const resources = path.join('/d', 'win-unpacked', 'resources');
    expect(layout.node).toBe(path.join(resources, 'node-runtime', 'node.exe'));
    expect(layout.entry).toBe(path.join(resources, 'claude-sdk-host', 'host.js'));
    expect(layout.cli).toBe(
      path.join(
        resources,
        'claude-sdk-host',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk-win32-x64',
        'claude.exe'
      )
    );
  });

  it('runs an unpacked artifact on this node unless told otherwise', () => {
    const layout = smokeLayout({ hostDir: '/a' }, 'linux', 'x64');
    expect(layout.node).toBe(process.execPath);
    expect(layout.cli).toBe(
      path.join('/a', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
    );
  });
});

describe('parseProbeOutput', () => {
  it('passes only on the probe saying every check passed', () => {
    expect(parseProbeOutput('...\nPROBE CHECKS: all 8 passed\n')).toEqual({
      ok: true,
      checks: 8,
      failed: [],
    });
    expect(
      parseProbeOutput(
        'PROBE CHECKS: 2 of 8 failed\n  - text: streams thinking\n  - tools: Bash ran\n'
      )
    ).toEqual({ ok: false, checks: 8, failed: ['text: streams thinking', 'tools: Bash ran'] });
    // A probe that died before its summary.
    expect(parseProbeOutput('PROBE FAILED: host exited').ok).toBe(false);
  });
});
