import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/**
 * Bundle the pinned plugin's real PermissionManager into a temporary ESM probe.
 * The package ships TypeScript with extensionless/#src imports, so ordinary
 * Node import cannot load it from node_modules. This helper is test/smoke-only;
 * production still loads the extension through pi's resource loader.
 */
export async function loadPermissionManagerProbe(hostRoot) {
  const pluginRoot = path.join(hostRoot, 'node_modules', '@gotgenes', 'pi-permission-system');
  const nonce = `${process.pid}-${Date.now()}`;
  const entryFile = path.join(hostRoot, `.aiclient-permission-probe-${nonce}.ts`);
  const outfile = path.join(hostRoot, `.aiclient-permission-probe-${nonce}.mjs`);
  const relativePluginRoot = `./${path.relative(hostRoot, pluginRoot).replaceAll(path.sep, '/')}`;
  fs.writeFileSync(
    entryFile,
    [
      `export { PermissionManager } from ${JSON.stringify(`${relativePluginRoot}/src/permission-manager.ts`)};`,
      `export { AccessPath } from ${JSON.stringify(`${relativePluginRoot}/src/access-intent/access-path.ts`)};`,
      `export { posixPathFlavor } from ${JSON.stringify(`${relativePluginRoot}/src/path/path-flavor.ts`)};`,
      '',
    ].join('\n')
  );

  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      external: ['@earendil-works/pi-coding-agent'],
      plugins: [
        {
          name: 'pi-permission-hash-src',
          setup(build) {
            build.onResolve({ filter: /^#src\// }, (args) => ({
              path: path.join(pluginRoot, 'src', `${args.path.slice('#src/'.length)}.ts`),
            }));
          },
        },
      ],
    });
  } catch (error) {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outfile, { force: true });
    throw error;
  }

  try {
    const module = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    return {
      PermissionManager: module.PermissionManager,
      AccessPath: module.AccessPath,
      posixPathFlavor: module.posixPathFlavor,
      cleanup: () => {
        fs.rmSync(entryFile, { force: true });
        fs.rmSync(outfile, { force: true });
      },
    };
  } catch (error) {
    fs.rmSync(entryFile, { force: true });
    fs.rmSync(outfile, { force: true });
    throw error;
  }
}
