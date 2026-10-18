/**
 * Run by verify-packaged-app inside the packaged executable with
 * ELECTRON_RUN_AS_NODE=1 (decision 200): loads each named package the way
 * Main resolves it, from out/main inside app.asar, native addons included.
 *
 *   <executable> runtime-load-probe.cjs <resources dir> <package>...
 *
 * Prints one JSON line: `{ "<package>": { "ok": true } | { "ok": false, "error": "..." } }`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const [resources, ...names] = process.argv.slice(2);
const load = createRequire(path.join(resources, 'app.asar', 'out', 'main', 'index.js'));

/** Extra steps a bare `require` does not reach. */
const deeper = {
  // node-pty loads its addon on the first spawn; load it now.
  'node-pty': () => {
    load('node-pty/lib/utils').loadNativeModule(process.platform === 'win32' ? 'conpty' : 'pty');
  },
  // SearchService runs rg from app.asar.unpacked.
  '@vscode/ripgrep': (exports) => {
    const rg = exports.rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
    if (!fs.existsSync(rg)) throw new Error(`missing ${rg}`);
  },
};

const report = {};
for (const name of names) {
  try {
    const exports = load(name);
    deeper[name]?.(exports);
    report[name] = { ok: true };
  } catch (error) {
    report[name] = { ok: false, error: String(error?.message ?? error).split('\n')[0] };
  }
}
console.log(JSON.stringify(report));
