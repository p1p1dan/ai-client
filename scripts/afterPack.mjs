import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * electron-builder afterPack hook.
 *
 * On Windows with TEC Solutions OCular Agent, any .js file written by a Node.js
 * process gets TSD-encrypted.  electron-builder writes asarUnpack files and
 * extraResources via Node.js, so they end up encrypted.
 * The packaged Electron process cannot decrypt them (no TEC drivers in user env).
 *
 * Fix: same pattern as winTsdFixPlugin —
 *   1. Node.js reads the file (TSD-transparent) → writes content to .tmp.bin (not encrypted)
 *   2. PowerShell copies .tmp.bin → original path (result is unencrypted)
 */
export default async function afterPack(context) {
  copyAgentHost(context);

  if (process.platform !== 'win32') return;

  const targets = [
    path.join(context.appOutDir, 'resources', 'app.asar.unpacked'),
    // Agent Host artifact — read by the external whitelisted node.exe on TSD
    // machines, but must stay unencrypted for non-TSD installs.
    path.join(context.appOutDir, 'resources', 'agent-host'),
  ];
  for (const dir of targets) {
    fixTsdEncryption(dir);
  }
}

/**
 * Copy the Agent Host artifact into resources/agent-host.
 *
 * Done here instead of extraResources for two reasons:
 *   1. electron-builder injects !**\/node_modules\/** into every extraResources
 *      copy (app-builder-lib fileMatcher), silently dropping the artifact's
 *      node_modules tree.
 *   2. The 87MB parallel copy raced rcedit's version-resource rewrite of
 *      AiClient.exe ("Unable to commit changes"); afterPack runs sequentially
 *      after packing, so there is no contention.
 */
function copyAgentHost(context) {
  const src = path.join(context.packager.info.projectDir, 'out-agent-host');
  if (!fs.existsSync(path.join(src, 'index.js'))) {
    throw new Error(
      `[afterPack] out-agent-host missing or incomplete at ${src} — run "pnpm build:agent-host" first`
    );
  }
  const dest = path.join(context.appOutDir, 'resources', 'agent-host');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[afterPack] Copied agent-host artifact -> ${dest}`);
}

function fixTsdEncryption(rootDir) {
  if (!fs.existsSync(rootDir)) return;

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

  collect(rootDir);
  if (files.length === 0) return;

  // Write decoded content to .tmp.bin (Node.js reads TSD transparently)
  for (const f of files) {
    fs.writeFileSync(`${f}.tmp.bin`, fs.readFileSync(f));
  }

  // PowerShell copies .tmp.bin -> original path (unencrypted result)
  const psScript =
    `Get-ChildItem '${rootDir}' -Recurse -Filter '*.tmp.bin' | ` +
    `ForEach-Object { $t=$_.FullName -replace '\\.tmp\\.bin$',''; ` +
    `[System.IO.File]::Copy($_.FullName,$t,$true); Remove-Item $_.FullName -Force }`;
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });

  console.log(`[afterPack] Fixed TSD encryption in ${files.length} file(s) in ${rootDir}`);
}
