import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * electron-builder afterPack hook.
 *
 * On Windows with TEC Solutions OCular Agent, any .js file written by a Node.js
 * process gets TSD-encrypted.  electron-builder writes asarUnpack files to
 * dist/.../app.asar.unpacked/ via Node.js, so they end up encrypted.
 * The packaged Electron process cannot decrypt them (no TEC drivers in user env).
 *
 * Fix: same pattern as winTsdFixPlugin —
 *   1. Node.js reads the file (TSD-transparent) → writes content to .tmp.bin (not encrypted)
 *   2. PowerShell copies .tmp.bin → original path (result is unencrypted)
 */
export default async function afterPack(context) {
  if (process.platform !== 'win32') return;

  const unpackedDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked'
  );
  if (!fs.existsSync(unpackedDir)) return;

  const exts = new Set(['.js', '.cjs', '.mjs']);
  const files = [];

  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
      } else if (exts.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }

  collect(unpackedDir);
  if (files.length === 0) return;

  // Write decoded content to .tmp.bin (Node.js reads TSD transparently)
  for (const f of files) {
    fs.writeFileSync(f + '.tmp.bin', fs.readFileSync(f));
  }

  // PowerShell copies .tmp.bin -> original path (unencrypted result)
  const psScript =
    `Get-ChildItem '${unpackedDir}' -Recurse -Filter '*.tmp.bin' | ` +
    `ForEach-Object { $t=$_.FullName -replace '\\.tmp\\.bin$',''; ` +
    `[System.IO.File]::Copy($_.FullName,$t,$true); Remove-Item $_.FullName -Force }`;
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });

  console.log(`[afterPack] Fixed TSD encryption in ${files.length} file(s) in app.asar.unpacked`);
}
