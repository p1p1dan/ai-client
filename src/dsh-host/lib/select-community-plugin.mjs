/**
 * P0-2: shortlist community host-only plugins from the dsh-plugin-catalog.
 *
 *   node lib/select-community-plugin.mjs <plugins.json> [--top 150] [--runtime 0.1.7-rc.2]
 *
 * For the `--top` most-downloaded catalog entries with an npm name, reads the
 * published manifest (`npm view`, npm registry only) and keeps those that
 *   - declare no `dsh.client` (host-only) and do declare `dsh.bundle`
 *     (plugin-manager installs bundles only),
 *   - have every `@deepseek-ai/dsh*` peer satisfied by the runtime version
 *     (prereleases included, as app-boot's admission check does),
 * then prints them ranked by downloads with dependency counts.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const semver = require('semver');
const run = promisify(execFile);

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const catalogPath = argv[0];
const top = Number(option('top', '150'));
const runtime = option('runtime', '0.1.7-rc.2');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const entries = catalog.plugins
  .filter((plugin) => typeof plugin.npm === 'string')
  .sort((a, b) => b.downloads - a.downloads)
  .slice(0, top);

async function manifest(entry) {
  try {
    const { stdout } = await run(
      'npm',
      [
        'view',
        `${entry.npm}@${entry.version}`,
        'dsh',
        'dependencies',
        'peerDependencies',
        '--json',
      ],
      { timeout: 60_000 }
    );
    return stdout.trim() === '' ? {} : JSON.parse(stdout);
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

function peerVerdict(peers = {}) {
  const dshPeers = Object.entries(peers).filter(([name]) => /^@deepseek-ai\/dsh(-|$)/.test(name));
  const unsatisfied = dshPeers.filter(
    ([, range]) => !semver.satisfies(runtime, range, { includePrerelease: true })
  );
  return { dshPeers: dshPeers.length, unsatisfied: unsatisfied.map(([n, r]) => `${n}@${r}`) };
}

const results = [];
const queue = [...entries];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const meta = await manifest(entry);
      const dsh = meta.dsh ?? {};
      results.push({
        npm: entry.npm,
        version: entry.version,
        downloads: entry.downloads,
        category: entry.category,
        capabilities: entry.capabilities ?? [],
        redLines: entry.capabilityRedLines ?? [],
        error: meta.error,
        client: dsh.client !== undefined,
        bundle: dsh.bundle !== undefined,
        dependencies: Object.keys(meta.dependencies ?? {}).length,
        peers: meta.peerDependencies ?? {},
        ...peerVerdict(meta.peerDependencies),
        description: (entry.description?.en ?? '').slice(0, 110),
      });
    }
  })
);

results.sort((a, b) => b.downloads - a.downloads);
const hostOnly = results.filter(
  (r) => !r.error && !r.client && r.bundle && r.unsatisfied.length === 0
);
process.stdout.write(
  `${JSON.stringify(
    {
      runtime,
      scanned: results.length,
      withClient: results.filter((r) => r.client).length,
      notBundle: results.filter((r) => !r.bundle && !r.error).length,
      peerRefused: results
        .filter((r) => r.unsatisfied.length > 0)
        .map((r) => ({ npm: r.npm, unsatisfied: r.unsatisfied })),
      errors: results.filter((r) => r.error).map((r) => r.npm),
      hostOnly,
    },
    null,
    2
  )}\n`
);
