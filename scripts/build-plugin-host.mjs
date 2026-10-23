/**
 * Bundle the plugin host (plugin-system README §3) to out-plugin-host/pluginHost.mjs.
 *
 * One self-contained ES module (.mjs, whatever package.json is nearby) run by the bundled Node; `afterPack` copies
 * it to resources/plugin-host. Development runs src/plugin-host/pluginHost.ts
 * as source instead.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'plugin-host', 'pluginHost.ts')],
  outfile: path.join(root, 'out-plugin-host', 'pluginHost.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'info',
});
