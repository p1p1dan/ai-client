#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = path.join(root, 'out', 'renderer');
const assetsDir = path.join(rendererDir, 'assets');
const mainDir = path.join(root, 'out', 'main');
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`  FAIL ${message}`);
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => ({
    name,
    path: path.join(dir, name),
    size: fs.statSync(path.join(dir, name)).size,
  }));
}

const assets = filesUnder(assetsDir);
for (const worker of [
  'editor.worker-',
  'ts.worker-',
  'json.worker-',
  'css.worker-',
  'html.worker-',
]) {
  const match = assets.find((asset) => asset.name.startsWith(worker) && asset.size > 0);
  if (!match) fail(`missing non-empty Monaco worker asset: ${worker}*`);
  else console.log(`  ok   ${match.name} (${match.size} bytes)`);
}

const pdfWorker = assets.find((asset) => /pdf\.worker/i.test(asset.name) && asset.size > 0);
if (!pdfWorker) fail('missing non-empty local PDF worker asset');
else console.log(`  ok   ${pdfWorker.name} (${pdfWorker.size} bytes)`);

const rendererJavaScript = assets
  .filter((asset) => asset.name.endsWith('.js'))
  .map((asset) => fs.readFileSync(asset.path, 'utf8'))
  .join('\n');
if (/cdn\.jsdelivr\.net\/npm\/pdfjs-dist/i.test(rendererJavaScript)) {
  fail('renderer still contains the PDF.js CDN URL');
} else {
  console.log('  ok   renderer has no PDF.js CDN dependency');
}

const mainJavaScript = filesUnder(mainDir)
  .filter((asset) => /\.(?:js|cjs|mjs)$/.test(asset.name))
  .map((asset) => fs.readFileSync(asset.path, 'utf8'))
  .join('\n');
if (!mainJavaScript.includes('local-file')) fail('built Main has no local-file protocol marker');
else console.log('  ok   built Main contains local-file protocol handling');

if (failures.length > 0) {
  console.error(`[verify-renderer-preview-assets] FAILED (${failures.length})`);
  process.exit(1);
}
console.log('[verify-renderer-preview-assets] OK');
