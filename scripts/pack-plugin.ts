/**
 * Pack a plugin directory into `<id>-<version>.pilabplug` (plugin-system README §3).
 *
 *   node scripts/pack-plugin.ts <plugin-dir> [out-dir]
 *
 * Validates `manifest.json` with the same rules PiLab installs by, checks that
 * `main` exists, and zips every file except dotfiles and earlier packs.
 * Dependencies are not resolved: bundle them into `main` first.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeZip } from '../src/main/services/plugins/zipWriter.ts';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PACKAGE_EXTENSION,
  parsePluginManifest,
} from '../src/shared/plugins/manifest.ts';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node scripts/pack-plugin.ts <plugin-dir> [out-dir]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const parsed = parsePluginManifest(
  JSON.parse(readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), 'utf8'))
);
if (!parsed.ok) {
  console.error(`manifest.json: ${parsed.error}`);
  process.exit(1);
}
const { manifest } = parsed;

function collect(relative: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(path.join(dir, relative)).sort()) {
    if (name.startsWith('.') || name.endsWith(PLUGIN_PACKAGE_EXTENSION)) continue;
    const child = relative ? `${relative}/${name}` : name;
    if (statSync(path.join(dir, child)).isDirectory()) files.push(...collect(child));
    else files.push(child);
  }
  return files;
}

const files = collect('');
if (!files.includes(manifest.main)) {
  console.error(`main ${manifest.main} does not exist in ${dir}`);
  process.exit(1);
}
const out = path.join(
  path.resolve(outArg ?? dir),
  `${manifest.id}-${manifest.version}${PLUGIN_PACKAGE_EXTENSION}`
);
writeFileSync(
  out,
  writeZip(files.map((file) => ({ path: file, data: readFileSync(path.join(dir, file)) })))
);
console.log(`${out} (${files.length} files)`);
