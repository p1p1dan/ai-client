import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundledNodePath, workerHost } from '../host/worker.ts';
import { runHostToolsProbe } from './p1-host-tools.ts';

const [cwd, nodePath, shellPath] = process.argv.slice(2);
const port = (process as typeof process & { parentPort: { postMessage(value: unknown): void } })
  .parentPort;

/**
 * Unpackaged Electron has no `resources/node-runtime`, and `workerHost` is
 * right to report no fallback there. Since the point of this probe is to run
 * the product derivation rather than hand it a config, a dev shell gets the
 * packaged layout built around the Node the runner passed in, and the report
 * says which of the two was used. Only the packaged run counts for P1-8.
 */
async function stageNodeRuntime(node: string): Promise<string> {
  if (!node) throw new Error('utility probe needs the path of a real Node executable');
  const root = await mkdtemp(join(tmpdir(), 'p1-utility-resources-'));
  const target = bundledNodePath(root, process.platform);
  await mkdir(dirname(target), { recursive: true });
  try {
    await symlink(node, target);
  } catch {
    // Windows dev shells without the symlink privilege.
    await copyFile(node, target);
  }
  return root;
}

let staged: string | undefined;
try {
  // tsd-06 — the same derivation the worker entry performs
  // (`src/agent-host/worker.ts`), so a probe that passes also says the product
  // would have produced this host, not just that tools run under a literal.
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!packaged || !existsSync(bundledNodePath(packaged, process.platform)))
    staged = await stageNodeRuntime(nodePath);
  const resourcesPath = staged ?? packaged;
  if (!resourcesPath) throw new Error('electron-utility probe found no resources path');
  const host = workerHost({ carrier: 'electron-utility', resourcesPath });
  // Stated rather than degraded: a probe that quietly fell back to an explicit
  // Node would report a pass for a configuration the product never builds.
  if (host.node?.source !== 'bundled' || host.tsdReadFallback !== 'configured-node') {
    throw new Error(
      `workerHost derived no shipped Node: ${JSON.stringify(host.node)} / ${host.tsdReadFallback}`
    );
  }
  const result = await runHostToolsProbe(host, cwd, shellPath);
  port.postMessage({ ...result, resourcesPath, stagedResources: Boolean(staged) });
  setImmediate(() => process.exit(result.passed ? 0 : 1));
} catch (error) {
  port.postMessage({ passed: false, error: error instanceof Error ? error.stack : String(error) });
  setImmediate(() => process.exit(1));
} finally {
  if (staged) await rm(staged, { recursive: true, force: true });
}
