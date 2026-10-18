import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  isRuntimePackage,
  MAIN_RUNTIME_ENTRIES,
  packageNameOf,
  RUNTIME_PACKAGES,
  runtimeFilePatterns,
  runtimeSpecifiers,
} from '../runtime-packages.mjs';

/**
 * Decision 200 — app.asar ships only the node_modules packages Main loads at
 * run time. These bind the list to the two places that would otherwise drift
 * from it without failing a build: electron-builder.yml, and Main's sources.
 * verify-packaged-app checks the built archive itself.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const builderYml = yaml.load(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('runtime packages in electron-builder.yml (decision 200)', () => {
  it('excludes every package but the runtime ones, in order', () => {
    const allBut = builderYml.files.filter(
      (pattern) => typeof pattern === 'string' && /^!node_modules\/(@[^/]+\/)?!\(/.test(pattern)
    );
    expect(allBut).toEqual(runtimeFilePatterns());
  });

  it('has no node_modules include, which electron-builder ignores for dependencies', () => {
    const includes = builderYml.files.filter(
      (pattern) => typeof pattern === 'string' && pattern.startsWith('node_modules')
    );
    expect(includes).toEqual([]);
  });

  it('keeps file patterns top-level only', () => {
    // A platform `files` list made electron-builder 26 drop the top-level
    // patterns for the app directory: the whole repo went into app.asar.
    for (const platform of ['win', 'linux', 'mac']) {
      expect(builderYml[platform]?.files, platform).toBeUndefined();
    }
  });

  it('ships no second copy of node_modules through extraResources', () => {
    for (const entry of builderYml.extraResources ?? []) {
      const to = typeof entry === 'string' ? entry : entry.to;
      expect(String(to)).not.toMatch(/^node_modules\b/);
    }
  });

  it('keeps every runtime entry a production dependency', () => {
    // electron-builder only collects `dependencies`; a devDependency here
    // would silently drop out of the archive.
    for (const name of MAIN_RUNTIME_ENTRIES) {
      expect(Object.keys(pkg.dependencies), name).toContain(name);
    }
  });

  it('keeps Chinese and English Chromium locales on Windows', () => {
    expect(builderYml.win.electronLanguages).toEqual(['zh-CN', 'zh-TW', 'en-US']);
  });

  it('runs the load check under the executable names the build emits', () => {
    const verifyText = readFileSync(
      path.join(repoRoot, 'scripts', 'verify-packaged-app.mjs'),
      'utf8'
    );
    expect(verifyText).toContain(`'${builderYml.linux.executableName}'`);
    expect(verifyText).toContain(`'${builderYml.win.executableName}.exe'`);
  });
});

describe("Main's run-time loads stay on the list (decision 200)", () => {
  it('lists every external of the Main build', () => {
    const config = readFileSync(path.join(repoRoot, 'electron.vite.config.ts'), 'utf8');
    const list = /runtimeNativePackages\s*=\s*\[([^\]]*)\]/.exec(config);
    expect(list).not.toBeNull();
    const externals = [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(externals.length).toBeGreaterThan(0);
    for (const name of externals) expect(MAIN_RUNTIME_ENTRIES).toContain(name);
  });

  it('lists every package Main loads through createRequire', () => {
    const loaded = new Set();
    for (const file of sourceFiles(path.join(repoRoot, 'src', 'main'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createRequire\([^)]*\)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        loaded.add(packageNameOf(match[1]));
      }
    }
    expect(loaded.size).toBeGreaterThan(0);
    for (const name of loaded) expect(MAIN_RUNTIME_ENTRIES, name).toContain(name);
  });
});

describe('runtimeSpecifiers', () => {
  it('finds static imports, dynamic imports, require and createRequire', () => {
    const source = [
      'import { spawn } from "node-pty";',
      'import sqlite3 from "sqlite3";',
      'import "side-effect";',
      'const lazy = await import("lazy-pkg/sub");',
      'const a = require("@scope/pkg/deep/file.js");',
      'const { subscribe } = createRequire(import.meta.url)("@parcel/watcher");',
    ].join('\n');
    expect(runtimeSpecifiers(source)).toEqual([
      '@parcel/watcher',
      '@scope/pkg',
      'lazy-pkg',
      'node-pty',
      'side-effect',
      'sqlite3',
    ]);
  });

  it('skips relative paths, node: builtins, electron and prose', () => {
    const source = [
      'import { app } from "electron";',
      'import fs from "node:fs";',
      'import { x } from "./chunk.js";',
      'const label = "switched from \'idle\' to busy";',
      'obj.require("not-a-call");',
      'const text = `the turn moved from "Cached" to "Unavailable"`;',
    ].join('\n');
    expect(runtimeSpecifiers(source)).toEqual([]);
  });
});

describe('isRuntimePackage', () => {
  it('accepts the list and the platform builds of @parcel/watcher', () => {
    for (const name of RUNTIME_PACKAGES) expect(isRuntimePackage(name)).toBe(true);
    expect(isRuntimePackage('@parcel/watcher-win32-x64')).toBe(true);
    expect(isRuntimePackage('@parcel/watcher-linux-x64-glibc')).toBe(true);
  });

  it('rejects what the bundles already carry', () => {
    for (const name of ['monaco-editor', 'react-dom', '@napi-rs/canvas', 'ws', 'node-gyp']) {
      expect(isRuntimePackage(name)).toBe(false);
    }
  });
});
