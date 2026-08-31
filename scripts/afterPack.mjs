import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';

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
  copyNodeRuntime(context);

  if (process.platform !== 'win32') return;

  const targets = [
    path.join(context.appOutDir, 'resources', 'app.asar.unpacked'),
    // Pi worker artifact — loaded by an Electron utilityProcess and kept as
    // plain files so the SDK and permission extension remain resolvable.
    path.join(context.appOutDir, 'resources', 'agent-host'),
  ];
  for (const dir of targets) {
    fixTsdEncryption(dir);
  }
}

/**
 * Copy the worker-only Pi artifact into resources/agent-host.
 *
 * Done here instead of extraResources because electron-builder injects a
 * node_modules exclusion into that copy path. afterPack also keeps the copy
 * serial with Windows executable resource rewriting.
 */
function copyAgentHost(context) {
  const src = path.join(context.packager.info.projectDir, 'out-agent-host');
  if (
    !fs.existsSync(path.join(src, 'worker.js')) ||
    !fs.existsSync(path.join(src, 'package.json')) ||
    !fs.existsSync(path.join(src, 'node_modules', '@gotgenes', 'pi-permission-system'))
  ) {
    throw new Error(
      `[afterPack] worker-only out-agent-host missing or incomplete at ${src} — run "pnpm build:agent-host" first`
    );
  }
  for (const obsolete of ['index.js', 'piHost.js']) {
    if (fs.existsSync(path.join(src, obsolete))) {
      throw new Error(`[afterPack] obsolete transition artifact still exists: ${obsolete}`);
    }
  }
  const dest = path.join(context.appOutDir, 'resources', 'agent-host');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[afterPack] Copied agent-host artifact -> ${dest}`);
}

/**
 * Copy the bundled Node runtime into resources/node-runtime (C-15 / D17, D36).
 *
 * Driven by NODE_RUNTIME_PINS rather than a hardcoded platform test: any
 * platform with a pin gets its runtime bundled, any platform without one is
 * skipped. On Windows the bundled node.exe additionally satisfies the TSD
 * whitelist-by-process-name story and the "no user-installed Node" case.
 *
 * Reads context.electronPlatformName, never process.platform — only the former
 * is correct when cross-compiling.
 *
 * Serial afterPack copy for the same rcedit-race reason as copyAgentHost.
 */
function copyNodeRuntime(context) {
  const platform = context.electronPlatformName;
  const arch = context.arch === undefined ? 'x64' : archToKey(context.arch);
  const pin = nodeRuntimePinFor(platform, arch);
  if (!pin) {
    console.log(
      `[afterPack] skip bundled Node runtime — no pin for ${platform}-${arch}; ` +
        `this platform falls back to machine Node discovery`
    );
    return;
  }

  const src = path.join(context.packager.info.projectDir, 'out-node-runtime');
  const srcBinary = path.join(src, pin.outName);
  if (!fs.existsSync(srcBinary)) {
    throw new Error(
      `[afterPack] out-node-runtime missing ${pin.outName} at ${src} — run ` +
        `"node scripts/fetch-node-runtime.mjs --platform ${pin.platformKey}" first`
    );
  }

  const dest = path.join(context.appOutDir, 'resources', 'node-runtime');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const destBinary = path.join(dest, pin.outName);
  fs.copyFileSync(srcBinary, destBinary);

  // copyFileSync preserves mode, but assert instead of assuming: a runtime
  // without the exec bit fails on the user's machine, not here.
  if (platform !== 'win32') {
    const mode = fs.statSync(destBinary).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(
        `[afterPack] bundled ${pin.outName} lost its exec bit (mode ` +
          `${(mode & 0o777).toString(8)}) while copying into ${dest}`
      );
    }
  }

  const pinJson = path.join(src, 'PIN.json');
  if (fs.existsSync(pinJson)) {
    fs.copyFileSync(pinJson, path.join(dest, 'PIN.json'));
  }
  console.log(
    `[afterPack] Copied bundled Node runtime v${NODE_RUNTIME_VERSION} ` +
      `(${pin.platformKey}) -> ${dest}`
  );
}

/** electron-builder's Arch enum -> the arch half of our pin keys. */
function archToKey(arch) {
  if (typeof arch === 'string') return arch;
  // Arch: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] ?? 'x64';
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
