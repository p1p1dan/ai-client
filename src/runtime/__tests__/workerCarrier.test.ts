import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateHost } from '../host/config.ts';
import { BUNDLED_HELPER_DIR, resolveHelper } from '../host/helpers.ts';
import { bundledNodePath, workerHost } from '../host/worker.ts';

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
