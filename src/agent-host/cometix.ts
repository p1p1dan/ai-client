/**
 * Resolve pinned Cometix (@cometix/claude-code) cli.js for Agent SDK executable path.
 */

import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMETIX_PIN } from './pin.ts';

const require = createRequire(import.meta.url);
const hostRoot = path.dirname(fileURLToPath(import.meta.url));

export interface CometixResolveResult {
  cliPath: string;
  packageRoot: string;
  version: string;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** Resolve Cometix cli entry from Host node_modules (pinned). */
export async function resolveCometixCli(): Promise<CometixResolveResult> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json', {
    paths: [hostRoot],
  });
  const packageRoot = path.dirname(pkgJson);
  const cliPath = await firstExisting([
    path.join(packageRoot, 'cli.js'),
    path.join(packageRoot, 'cli.mjs'),
    path.join(packageRoot, 'bin', 'cli.js'),
    path.join(packageRoot, 'dist', 'cli.js'),
  ]);
  if (!cliPath) {
    throw new Error(`Cometix cli.js not found under ${packageRoot}`);
  }
  return {
    cliPath,
    packageRoot,
    version: COMETIX_PIN.version,
  };
}
