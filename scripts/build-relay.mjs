/**
 * Bundle pilab-relay (mobile-remote README §4.3) into out-relay/pilab-relay.mjs:
 * the server, `ws`, and the web page in one file run by any Node 20+.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const webDir = path.join(root, 'relay', 'web');
const assets = Object.fromEntries(
  readdirSync(webDir).map((name) => [
    name,
    {
      type: TYPES[path.extname(name)] ?? 'application/octet-stream',
      body: readFileSync(path.join(webDir, name), 'utf8'),
    },
  ])
);

await build({
  entryPoints: [path.join(root, 'relay', 'main.ts')],
  outfile: path.join(root, 'out-relay', 'pilab-relay.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // `ws` reaches for these optional natives with require(); none is needed.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  define: { __RELAY_ASSETS__: JSON.stringify(assets) },
  legalComments: 'none',
  logLevel: 'info',
});
