import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateHost } from '../host/config.ts';
import { BUNDLED_HELPER_DIR, resolveHelper } from '../host/helpers.ts';
import { bundledNodePath, RUNTIME_TSD_FALLBACK_ENV, workerHost } from '../host/worker.ts';
import { carrierEvidence } from '../smoke/p1-host-tools.ts';

/**
 * ARD D11 — compatibility follows the process binary, so the carrier decides
 * which Node (if any) may be spawned to read a TSD-encrypted file. The trap
 * these tests guard is offering `process.execPath` as that helper: under
 * `electron-utility` it is the Electron binary, which is exactly the process
 * the encrypted host does NOT whitelist.
 */

let resources: string;
beforeEach(async () => {
  resources = await mkdtemp(join(tmpdir(), 'runtime-carrier-'));
});
afterEach(async () => {
  await rm(resources, { recursive: true, force: true });
});

async function writeBundledNode(platform: NodeJS.Platform): Promise<string> {
  const target = bundledNodePath(resources, platform);
  await mkdir(join(resources, 'node-runtime'), { recursive: true });
  await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return target;
}

describe('workerHost (D11 carrier matrix)', () => {
  it('bundled-node uses this process as the bundled Node and needs no TSD fallback', async () => {
    const host = workerHost({ carrier: 'bundled-node', env: {}, execPath: process.execPath });
    expect(host.carrier).toBe('bundled-node');
    expect(host.node).toEqual({ path: process.execPath, source: 'bundled' });
    // The carrier exists because this binary is whitelisted; re-spawning it to
    // decrypt would only repeat the same read.
    expect(host.tsdReadFallback).toBe('disabled');
    await expect(validateHost(host)).resolves.toBeUndefined();
  });

  it('electron-utility offers the shipped Node, never Electron itself', async () => {
    const bundled = await writeBundledNode(process.platform);
    const host = workerHost({
      carrier: 'electron-utility',
      env: {},
      execPath: '/opt/app/electron',
      resourcesPath: resources,
    });
    expect(host.carrier).toBe('electron-utility');
    expect(host.node).toEqual({ path: bundled, source: 'bundled' });
    expect(host.node?.path).not.toBe('/opt/app/electron');
    expect(host.tsdReadFallback).toBe('configured-node');
    await expect(validateHost(host)).resolves.toBeUndefined();
  });

  it('electron-utility without a shipped Node reports no fallback rather than a broken one', async () => {
    const host = workerHost({ carrier: 'electron-utility', env: {}, resourcesPath: resources });
    expect(host.node).toBeUndefined();
    expect(host.tsdReadFallback).toBe('disabled');
    await expect(validateHost(host)).resolves.toBeUndefined();
  });

  it('unpackaged dev shells have no resourcesPath at all', async () => {
    const host = workerHost({ carrier: 'electron-utility', env: {} });
    expect(host.node).toBeUndefined();
    expect(host.tsdReadFallback).toBe('disabled');
    await expect(validateHost(host)).resolves.toBeUndefined();
  });

  /**
   * tsd-01 — before this switch the fallback had no factory trigger at all:
   * the one carrier that meets ciphertext (packaged Windows) hardcoded it off,
   * and the carriers that enabled it run where no encryption driver exists. An
   * encrypted box can now exercise the helper, and a machine whose driver
   * stopped whitelisting our binary can be told to try, without a rebuild.
   */
  it('lets the field switch turn the fallback on for bundled-node', async () => {
    const host = workerHost({
      carrier: 'bundled-node',
      env: { [RUNTIME_TSD_FALLBACK_ENV]: '1' },
      execPath: process.execPath,
    });
    expect(host.tsdReadFallback).toBe('configured-node');
    // Still the binary Main spawned us as, never a second copy from disk.
    expect(host.node).toEqual({ path: process.execPath, source: 'bundled' });
    await expect(validateHost(host)).resolves.toBeUndefined();
  });

  it('keeps the fallback off for anything but an explicit on value', () => {
    for (const value of ['', '0', 'off', 'no', 'maybe']) {
      const host = workerHost({
        carrier: 'bundled-node',
        env: { [RUNTIME_TSD_FALLBACK_ENV]: value },
        execPath: process.execPath,
      });
      expect(host.tsdReadFallback).toBe('disabled');
    }
  });

  it('cannot switch on a fallback with no Node to spawn', () => {
    const host = workerHost({
      carrier: 'electron-utility',
      env: { [RUNTIME_TSD_FALLBACK_ENV]: 'on' },
      resourcesPath: resources,
    });
    expect(host.node).toBeUndefined();
    expect(host.tsdReadFallback).toBe('disabled');
  });

  it('names the Windows binary on Windows', () => {
    expect(bundledNodePath('C:\\app\\resources', 'win32')).toContain('node.exe');
    expect(bundledNodePath('/app/resources', 'darwin')).not.toContain('.exe');
  });

  it('passes only defined environment entries to children', () => {
    const host = workerHost({
      carrier: 'electron-utility',
      env: { KEEP: 'yes', DROP: undefined },
    });
    expect(host.childEnv).toEqual({ KEEP: 'yes' });
    expect(host.exec).toEqual({ mode: 'pipe' });
  });
});

describe('resolveHelper (P4-1 packaging)', () => {
  it('finds a helper sitting beside its caller, as it does in dev', async () => {
    const helper = join(resources, 'exec-runner.mjs');
    await writeFile(helper, '// helper\n');
    expect(resolveHelper('exec-runner.mjs', pathToFileURL(join(resources, 'io.ts')).href)).toBe(
      helper
    );
  });

  it('falls back to the bundle layout, where the caller collapsed into worker.js', async () => {
    await mkdir(join(resources, BUNDLED_HELPER_DIR), { recursive: true });
    const helper = join(resources, BUNDLED_HELPER_DIR, 'tsd-read.mjs');
    await writeFile(helper, '// helper\n');
    expect(resolveHelper('tsd-read.mjs', pathToFileURL(join(resources, 'worker.js')).href)).toBe(
      helper
    );
  });

  it('names both places it looked when the helper is missing', () => {
    // A packaging slip reported as a bare ENOENT costs an afternoon; the two
    // candidate paths say immediately which layout was expected.
    expect(() =>
      resolveHelper('tsd-read.mjs', pathToFileURL(join(resources, 'worker.js')).href)
    ).toThrow(/runtime-helpers/);
  });
});

/**
 * tsd-06 — what the P1-8 probes assert about the carrier. The old assertion
 * compared the trace's carrier with the object the trace copied it from, so it
 * could not fail; these are the comparisons that can.
 */
describe('carrierEvidence (P1-8 probe assertions)', () => {
  const shippedNode = { path: '/app/resources/node-runtime/node', source: 'bundled' as const };
  const utility = { carrier: 'electron-utility' as const, node: shippedNode };

  it('passes when the process matches the carrier it claims', () => {
    expect(
      carrierEvidence(utility, {
        execPath: '/opt/app/electron',
        electron: '38.0.0',
        platform: 'linux',
      })
    ).toBe(true);
    expect(
      carrierEvidence(
        { carrier: 'bundled-node', node: { path: 'C:\\app\\node.exe', source: 'bundled' } },
        { execPath: 'C:\\App\\node.exe', electron: null, platform: 'win32' }
      )
    ).toBe(true);
    expect(
      carrierEvidence(
        {
          carrier: 'standalone-node',
          node: { path: process.execPath, source: 'current-process' },
        },
        { execPath: process.execPath, electron: null, platform: process.platform }
      )
    ).toBe(true);
  });

  it('fails the mismatches the old tautology waved through', () => {
    // Claims the Electron carrier from a process with no Electron in it.
    expect(
      carrierEvidence(utility, {
        execPath: '/opt/app/electron',
        electron: null,
        platform: 'linux',
      })
    ).toBe(false);
    // Offers its own Electron binary as the TSD helper — the D11 trap.
    expect(
      carrierEvidence(
        { carrier: 'electron-utility', node: { path: '/opt/app/electron', source: 'bundled' } },
        { execPath: '/opt/app/electron', electron: '38.0.0', platform: 'linux' }
      )
    ).toBe(false);
    // Claims bundled-node from inside Electron, or points at a different Node.
    expect(
      carrierEvidence(
        { carrier: 'bundled-node', node: { path: '/app/node', source: 'bundled' } },
        { execPath: '/app/node', electron: '38.0.0', platform: 'linux' }
      )
    ).toBe(false);
    expect(
      carrierEvidence(
        { carrier: 'bundled-node', node: { path: '/usr/bin/node', source: 'bundled' } },
        { execPath: '/app/node', electron: null, platform: 'linux' }
      )
    ).toBe(false);
  });
});
