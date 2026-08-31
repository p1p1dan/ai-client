#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-preview-build-probe-'));

try {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(root, 'src/renderer/components/files/pdfSetup.ts'),
        formats: ['es'],
        fileName: 'pdf-setup-probe',
      },
    },
  });

  const assetsDir = path.join(outDir, 'assets');
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const worker = assets.find((name) => /pdf\.worker/i.test(name));
  if (!worker) throw new Error('Vite emitted no local PDF worker asset');
  const workerSize = fs.statSync(path.join(assetsDir, worker)).size;
  if (workerSize === 0) throw new Error(`Vite emitted an empty PDF worker: ${worker}`);

  const output = fs
    .readdirSync(outDir, { recursive: true })
    .filter((name) => typeof name === 'string' && name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(outDir, name), 'utf8'))
    .join('\n');
  if (/cdn\.jsdelivr\.net\/npm\/pdfjs-dist/i.test(output)) {
    throw new Error('PDF build probe still contains the PDF.js CDN URL');
  }

  const monacoSource = fs.readFileSync(
    path.join(root, 'src/renderer/components/files/monacoSetup.ts'),
    'utf8'
  );
  for (const workerName of [
    'editor.worker',
    'ts.worker',
    'json.worker',
    'css.worker',
    'html.worker',
  ]) {
    if (!monacoSource.includes(workerName)) {
      throw new Error(`Monaco setup is missing local ${workerName}`);
    }
  }

  console.log(`[verify-preview-build-probe] PDF worker ${worker} (${workerSize} bytes)`);
  console.log('[verify-preview-build-probe] Monaco local worker imports present');
  console.log('[verify-preview-build-probe] OK');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
