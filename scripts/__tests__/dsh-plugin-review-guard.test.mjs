import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hostBaseClosure, pluginClosure } from '../../src/shared/dshPluginAllowlist.ts';
import {
  BRIDGE_ENTRIES,
  HOST_DEPENDENCIES,
  loadStagedDsh,
  PRODUCT_BUNDLE,
  preflightDshHost,
  readJson,
} from '../dsh-host-build-lib.mjs';
import {
  CRITERIA,
  decodeEscapes,
  deriveGuardTargets,
  formatHits,
  inRanges,
  isGuardSkipped,
  nonCodeRanges,
  OWN_PRODUCT_ROWS,
  packageOfSpecifier,
  SERVICE_ALIAS_WINDOW,
  scanPackage,
  scanText,
} from '../dsh-plugin-review-guard.mjs';

/**
 * dsh-rebase E8-A (decisions 149 rule 4, 150 and 153): the three must-reject
 * review criteria, applied to every third-party plugin package the host ships
 * as it is installed in src/dsh-host/node_modules (CI's gate runs `npm ci`
 * there before `pnpm test`, as for dsh-plugin-allowlist.test.mjs).
 *
 * What is scanned is derived (the allowlist, and every product-bundle row that
 * mounts a package other than our own bundle), never listed here; what is not
 * scanned is our own rows, listed by hand twice (the module and below) so the
 * exemption cannot grow without a visible change. A hit fails: the answer to a
 * hit in a shipped plugin is to drop the plugin or take it to the user, never
 * an exemption.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDir = path.join(repoRoot, 'src', 'dsh-host');
const nodeModules = path.join(sourceDir, 'node_modules');
const probePlugin = path.join(sourceDir, 'tools', 'credential-probe-plugin');

/** The second key of the exemption: changing OWN_PRODUCT_ROWS means changing this too. */
const EXPECTED_OWN_ROWS = [
  'aiclient-bridge',
  'aiclient-credentials',
  'aiclient-encrypted-read',
  'aiclient-loop-guard',
  'aiclient-permissions',
];

const rulesOf = (hits) => hits.map((hit) => `${hit.criterion}/${hit.rule}`);
const criteriaOf = (hits) => [...new Set(hits.map((hit) => hit.criterion))].sort();

/** The entry module a package loads by default, relative to its directory. */
function entryOf(dir) {
  const manifest = readJson(path.join(dir, 'package.json'));
  let entry = manifest.exports?.['.'] ?? manifest.exports;
  while (entry && typeof entry === 'object') {
    entry = entry.node ?? entry.import ?? entry.require ?? entry.default;
  }
  return path.posix.normalize(typeof entry === 'string' ? entry : (manifest.main ?? 'index.js'));
}

describe('the shipped third-party plugins', () => {
  let derived;
  let preflight;
  let lock;
  beforeAll(async () => {
    const dsh = await loadStagedDsh(sourceDir);
    preflight = preflightDshHost(sourceDir);
    lock = readJson(path.join(sourceDir, 'package-lock.json'));
    const bundleDir = path.join(sourceDir, 'bundle');
    const declared = readJson(path.join(bundleDir, 'package.json')).dsh.bundle.patch;
    const productPatches = (Array.isArray(declared) ? declared : [declared]).flatMap((file) =>
      dsh.loadOverlayPatches('dsh-plugin-review-guard', path.join(bundleDir, file))
    );
    derived = deriveGuardTargets({
      allowlist: preflight.allowlist,
      productPatches,
      productBundle: PRODUCT_BUNDLE,
    });
  });

  it('are derived from the allowlist and the product bundle', () => {
    expect(derived.failures).toEqual([]);
    expect(derived.targets.length).toBeGreaterThan(0);
    const names = derived.targets.map((target) => target.name);
    for (const entry of preflight.allowlist.plugins) expect(names).toContain(entry.name);
    // Everything scanned is installed by the host package, and none of it is ours.
    for (const name of names) {
      expect(name).not.toBe(PRODUCT_BUNDLE);
      const allowlisted = preflight.allowlist.plugins.some((entry) => entry.name === name);
      expect(allowlisted || HOST_DEPENDENCIES.includes(name), name).toBe(true);
    }
  });

  it('exempt only our own rows, listed by hand', () => {
    expect([...OWN_PRODUCT_ROWS].sort()).toEqual(EXPECTED_OWN_ROWS);
    expect([...derived.own].sort()).toEqual(EXPECTED_OWN_ROWS);
    expect(BRIDGE_ENTRIES.map((entry) => entry.row).sort()).toEqual(EXPECTED_OWN_ROWS);
    for (const row of OWN_PRODUCT_ROWS) expect(row.startsWith('aiclient-')).toBe(true);
    expect(Object.isFrozen(OWN_PRODUCT_ROWS)).toBe(true);
  });

  it('are installed at the version the host locks', () => {
    for (const { name } of derived.targets) {
      const dir = path.join(nodeModules, ...name.split('/'));
      expect(fs.existsSync(path.join(dir, 'package.json')), `${name} is not installed`).toBe(true);
      const installed = readJson(path.join(dir, 'package.json')).version;
      expect(installed, name).toBe(lock.packages[`node_modules/${name}`]?.version);
      const listed = preflight.allowlist.plugins.find((entry) => entry.name === name);
      if (listed) expect(installed, name).toBe(listed.version);
    }
  });

  it('meet none of the three must-reject criteria', () => {
    const names = derived.targets.map((target) => target.name);
    const base = hostBaseClosure(lock, names);
    const failures = [];
    const summary = {};
    for (const { name } of derived.targets) {
      const dir = path.join(nodeModules, ...name.split('/'));
      const closure = pluginClosure(lock, name, base).map((rel) =>
        path.join(sourceDir, ...rel.split('/'))
      );
      const scan = scanPackage({ dir, closure, base: nodeModules });
      const version = readJson(path.join(dir, 'package.json')).version;
      summary[name] = { files: scan.files.length, closure: closure.length };
      // A walker that read nothing would pass anything: the entries must be read.
      for (const pkg of [dir, ...closure]) {
        const entry = path.relative(nodeModules, path.join(pkg, entryOf(pkg))).split(path.sep);
        expect(scan.files, `${name}: entry of ${pkg}`).toContain(entry.join('/'));
      }
      failures.push(...formatHits(name, version, scan.hits));
    }
    expect(Object.keys(summary).sort()).toEqual([...names].sort());
    expect(failures, `criteria: ${JSON.stringify(CRITERIA, null, 2)}`).toEqual([]);
  });
});

describe('deriveGuardTargets', () => {
  const allowlist = { plugins: [{ name: 'community-tools' }] };
  const own = OWN_PRODUCT_ROWS.map((id) => ({ id, name: `${PRODUCT_BUNDLE}/${id}` }));
  const derive = (rows) =>
    deriveGuardTargets({
      allowlist,
      productPatches: [{ insert: rows }],
      productBundle: PRODUCT_BUNDLE,
    });

  it('scans a product row of any other package, @deepseek-ai/* included', () => {
    const { targets, failures } = derive([
      ...own,
      { id: 'tool-x', name: '@deepseek-ai/dsh-tool-x' },
      { id: 'grouped', group: true, config: [{ id: 'inner', name: 'plain-plugin/lib' }] },
    ]);
    expect(failures).toEqual([]);
    expect(targets.map((target) => target.name)).toEqual([
      'community-tools',
      '@deepseek-ai/dsh-tool-x',
      'plain-plugin',
    ]);
  });

  it('fails when our own rows and the list part ways', () => {
    expect(
      derive([...own, { id: 'aiclient-new', name: `${PRODUCT_BUNDLE}/new` }]).failures
    ).toEqual([
      `product row aiclient-new loads ${PRODUCT_BUNDLE}/new, a module of ${PRODUCT_BUNDLE}, but is not in OWN_PRODUCT_ROWS`,
    ]);
    expect(derive(own.slice(1)).failures).toEqual([
      `OWN_PRODUCT_ROWS names ${OWN_PRODUCT_ROWS[0]}, which the product bundle does not insert`,
    ]);
    const swapped = [...own.slice(1), { id: OWN_PRODUCT_ROWS[0], name: 'someone-else' }];
    expect(derive(swapped).failures).toContain(
      `product row ${OWN_PRODUCT_ROWS[0]} is listed as our own but loads someone-else`
    );
  });

  it('maps module specifiers to packages', () => {
    expect(packageOfSpecifier('@deepseek-ai/dsh-tool-ask-user')).toBe(
      '@deepseek-ai/dsh-tool-ask-user'
    );
    expect(packageOfSpecifier('@aiclient/dsh-app/bridge')).toBe('@aiclient/dsh-app');
    expect(packageOfSpecifier('dsh-office-tools/lib/index.js')).toBe('dsh-office-tools');
  });
});

describe('the criteria on reverse samples', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-guard-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel, content) => {
    const file = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  it('the E8 probe plugin meets all three', () => {
    const { hits } = scanPackage({ dir: probePlugin });
    expect(criteriaOf(hits)).toEqual(['credentials', 'escape', 'host-ipc']);
    expect(rulesOf(hits)).toEqual(
      expect.arrayContaining([
        'credentials/inject-credentials',
        'credentials/ctx-credentials',
        'host-ipc/message-listener',
        'host-ipc/prepend-listener',
        'host-ipc/send',
        'escape/cordis-original',
        'escape/property-write',
      ])
    );
  });

  it('each criterion alone fails a fixture plugin, with file, line and rule', () => {
    write('package.json', '{"name":"fixture","version":"1.0.0","main":"lib/index.js"}');
    write('lib/index.js', "export const name = 'fixture';\n");
    write('lib/one.js', "export function apply(ctx) {\n  return ctx.get('credentials');\n}\n");
    write('lib/two.cjs', "module.exports = () => {\n  process.on('message', (m) => m);\n};\n");
    write('lib/three.mjs', "const k = Symbol.for('cordis.original');\nexport { k };\n");
    const { files, hits } = scanPackage({ dir: tmp });
    expect(files).toEqual(['lib/index.js', 'lib/one.js', 'lib/three.mjs', 'lib/two.cjs']);
    expect(hits.map(({ file, line, criterion, rule }) => [file, line, criterion, rule])).toEqual([
      ['lib/one.js', 2, 'credentials', 'ctx-get-credentials'],
      ['lib/three.mjs', 1, 'escape', 'cordis-original'],
      ['lib/two.cjs', 2, 'host-ipc', 'message-listener'],
    ]);
    expect(formatHits('fixture', '1.0.0', hits)[0]).toBe(
      "fixture@1.0.0: lib/one.js:2:10 [credentials/ctx-get-credentials] ctx.get('credentials'"
    );
  });

  it('criterion 1: the service by property, by get, or injected', () => {
    for (const source of [
      'ctx.credentials.resolve(ref)',
      'this.ctx?.credentials',
      "ctx['credentials']",
      'context.credentials',
      'ctx.get("credentials")',
      "export const inject = ['fs', 'credentials']",
      'export const inject = { credentials: { required: true } }',
      "ctx.inject(['credentials'], (c) => c)",
    ]) {
      expect(criteriaOf(scanText(source)), source).toEqual(['credentials']);
    }
  });

  it('criterion 2: every way onto the IPC channel the ruling names', () => {
    for (const source of [
      'process.send({ host: "credential" })',
      'globalThis.process.send(m)',
      "process.on('message', listener)",
      'process.once("message", listener)',
      "process.prependListener('message', listener)",
      "process.prependOnceListener('exit', f)",
      "process.removeAllListeners('message')",
      'process.removeAllListeners()',
      "process['send'](m)",
      "const p = process;\np.on('message', f)",
      "import proc from 'node:process';\nproc.send(m)",
    ]) {
      expect(criteriaOf(scanText(source)), source).toEqual(['host-ipc']);
    }
  });

  it('criterion 3: escaping the proxy and the property writes it names', () => {
    for (const source of [
      "service[Symbol.for('cordis.original')]",
      "const key = 'cordis.original'",
      "ctx.get('fs').readText = evil",
      "const fs = ctx.get('fs');\nfs.readText = evil",
      'ctx.fs.readText = evil',
      'process.emit = wrapped',
      'process["binding"] = evil',
      'globalThis.fetch = spy',
      'global.setTimeout = spy',
      "Object.defineProperty(process, 'send', { value: spy })",
      "Reflect.set(globalThis, 'fetch', spy)",
      "Object.assign(ctx.get('fs'), { readText: evil })",
      "import Module from 'node:module';\nModule._load = evil",
      "const { Module: M } = require('module');\nM.prototype.require = evil",
      "require('module')._resolveFilename = evil",
      'module.constructor._load = evil',
      'require.cache[file] = fake',
      "import { EventEmitter } from 'node:events';\nEventEmitter.prototype.emit = spy",
      'Function.prototype.call = spy',
    ]) {
      expect(criteriaOf(scanText(source)), source).toEqual(['escape']);
    }
  });

  it('near misses stay clean', () => {
    for (const source of [
      // Comments and strings do not count, except for cordis.original.
      '// never touches ctx.credentials or process.send',
      'const help = "polyfill it: globalThis.fetch = fetch";',
      'throw new Error(\'process.on("message") is not for plugins\')',
      // Reads, comparisons, other receivers, other events.
      "const service = ctx.get('sandboxPolicy');\nservice.resolve({})",
      'if (process.env.X === "1") run()',
      'process.env.DEBUG = "x"',
      "process.on('exit', f)",
      "worker.on('message', f)",
      'child.send(m)',
      'options.credentials = "include"',
      'const { credentials } = config',
      'ctx.fs.readText(file)',
      'const x = globalThis.fetch',
      "Object.defineProperty(exports, '__esModule', { value: true })",
      // emscripten's own Module object, not node:module.
      'var Module = {}; Module.preRun = []',
      // A UMD wrapper's own `global` parameter.
      '(function (global, factory) { global.Lib = factory(); })(this, () => ({}))',
    ]) {
      expect(scanText(source), source).toEqual([]);
    }
  });

  it('`ctx.<service>.<prop> = ` counts in the plugin, not in its dependencies', () => {
    write('lib/index.js', 'export function apply(ctx) { ctx.fs.readText = evil; }\n');
    write('node_modules/koa-like/index.js', 'module.exports = (ctx) => { ctx.state.user = 1; };\n');
    write('node_modules/bad-dep/index.js', "module.exports = () => process.on('message', f);\n");
    const { hits } = scanPackage({ dir: tmp });
    expect(hits.map((hit) => [hit.file, hit.rule])).toEqual([
      ['lib/index.js', 'property-write'],
      ['node_modules/bad-dep/index.js', 'message-listener'],
    ]);
  });

  it('a write through a service binding counts within the window after it', () => {
    const near = "const s = ctx.get('fs');\ns.readText = evil;";
    expect(rulesOf(scanText(near))).toEqual(['escape/property-write']);
    const far = `const s = ctx.get('fs');\n${' '.repeat(SERVICE_ALIAS_WINDOW)}\ns.readText = evil;`;
    expect(scanText(far)).toEqual([]);
  });

  it('a NUL byte or an escape hides nothing', () => {
    write(
      'lib/index.js',
      Buffer.concat([
        Buffer.from('const a = 1;\0\0\n'),
        Buffer.from("process.\\u006fn('\\x6dessage', f);\n"),
        Buffer.from('ctx.cred\\u{65}ntials\n'),
      ])
    );
    const { hits } = scanPackage({ dir: tmp });
    expect(hits.map((hit) => [hit.line, hit.criterion])).toEqual([
      [2, 'host-ipc'],
      [3, 'credentials'],
    ]);
  });

  it('a bundle patch expression is read too, past a YAML comment', () => {
    write(
      'cordis.patch.yml',
      [
        '# mounts lib/*.js; never reads ctx.credentials',
        '- id: x',
        '  config:',
        "    key: !!js ctx.get('credentials')",
        '    other: !!js "process.send(1)"',
        '',
      ].join('\n')
    );
    const { hits } = scanPackage({ dir: tmp });
    expect(hits.map((hit) => [hit.line, hit.rule])).toEqual([
      [4, 'ctx-get-credentials'],
      [5, 'send'],
    ]);
  });

  it('skips what Node never loads, and says so', () => {
    write('lib/index.js', 'export {};\n');
    write('README.md', 'Never calls ctx.credentials.\n');
    write('lib/types/index.d.ts', 'export declare const credentials: unknown;\n');
    write('test/fake.js', 'process.send = spy;\n');
    write('lib/index.test.js', 'process.send = spy;\n');
    write('LICENSE', 'process.send\n');
    const { files, skipped, hits } = scanPackage({ dir: tmp });
    expect(files).toEqual(['lib/index.js']);
    expect(skipped.sort()).toEqual(
      ['LICENSE', 'README.md', 'lib/index.test.js', 'lib/types/index.d.ts', 'test/fake.js'].sort()
    );
    expect(hits).toEqual([]);
    expect(isGuardSkipped('node_modules/dep/docs/a.js')).toBe(true);
    expect(isGuardSkipped('node_modules/@s/dep/lib/test.js')).toBe(false);
  });
});

describe('the lexer behind code-only rules', () => {
  /** Masks non-code with `_`; `@{` in the samples stands for a template's `${`. */
  const masked = (sample) => {
    const text = sample.replaceAll('@{', '$' + '{');
    const ranges = nonCodeRanges(text);
    return [...text]
      .map((char, index) => (inRanges(ranges, index) ? '_' : char))
      .join('')
      .replaceAll('$' + '{', '@{');
  };

  it('masks comments, string and template text and regex literals, not template code', () => {
    expect(masked("a('x'); // c\nb(`t@{y}u`); /* d */ e(/r\\/s/g, 2 / 3)")).toBe(
      "a('_'); ____\nb(`_@{y}_`); _______ e(______g, 2 / 3)"
    );
    expect(masked('return /x/.test(s)')).toBe('return ___.test(s)');
    expect(masked('`a@{{ b: 1 }.b}c`')).toBe('`_@{{ b: 1 }.b}_`');
  });

  it('decodes only escapes that spell identifier characters', () => {
    expect(decodeEscapes("process.\\u006fn('\\x6dessage')")).toBe("process.on('message')");
    expect(decodeEscapes("'\\x27' \\u{110000} \\x0a")).toBe("'\\x27' \\u{110000} \\x0a");
  });
});
