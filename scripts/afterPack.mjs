import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  CLAUDE_SDK_HOST_OUT_REL,
  verifyClaudeSdkHostArtifact,
} from './claude-sdk-host-build-lib.mjs';
import { DSH_HOST_MANIFEST, executablePaths } from './dsh-host-build-lib.mjs';
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
  // dsh-rebase P1-12 step 1 (decision 147): no `resources/agent-host` any more.
  // The native worker artifact is neither built nor copied; the DSH host is
  // the only engine the package carries.
  copyDshHost(context);
  copyClaudeSdkHost(context);
  copyNodeRuntime(context);

  if (process.platform !== 'win32') return;

  const targets = [
    path.join(context.appOutDir, 'resources', 'app.asar.unpacked'),
    // DSH host artifact: plain files run by the bundled node.exe (dsh-rebase P1-2).
    path.join(context.appOutDir, 'resources', 'dsh-host'),
    // Claude Agent SDK host (route B S-4 B-11): host.js and the SDK's .mjs files.
    path.join(context.appOutDir, 'resources', 'claude-sdk-host'),
  ];
  for (const dir of targets) {
    fixTsdEncryption(dir);
  }
}

/**
 * Copy the DSH host artifact into resources/dsh-host (dsh-rebase P1-2,
 * decision 011). Done here instead of extraResources because electron-builder
 * injects a node_modules exclusion into that copy path; afterPack also keeps
 * the copy serial with Windows executable resource rewriting. The artifact
 * is built for one platform (its natives are installed for the build
 * machine), so its manifest must name the target being packaged.
 */
export function copyDshHost(context) {
  const src = path.join(context.packager.info.projectDir, 'out-dsh-host');
  for (const rel of [
    'host.js',
    'package.json',
    DSH_HOST_MANIFEST,
    'node_modules/@aiclient/dsh-app/lib/bridge.js',
  ]) {
    if (!fs.existsSync(path.join(src, ...rel.split('/')))) {
      throw new Error(
        `[afterPack] out-dsh-host missing or incomplete at ${src} (no ${rel}) — run "pnpm build:dsh-host" first`
      );
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(src, DSH_HOST_MANIFEST), 'utf8'));
  const platform = context.electronPlatformName;
  const arch = context.arch === undefined ? 'x64' : archToKey(context.arch);
  const built = `${manifest.target?.platform}-${manifest.target?.arch}`;
  if (built !== `${platform}-${arch}`) {
    throw new Error(
      `[afterPack] out-dsh-host was built for ${built}, not ${platform}-${arch} — build it on the target platform`
    );
  }
  const dest = path.join(resolveResourcesDir(context), 'dsh-host');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  if (platform !== 'win32') {
    for (const rel of executablePaths({ platform, arch })) {
      const file = path.join(dest, ...rel.split('/'));
      if (fs.existsSync(file) && (fs.statSync(file).mode & 0o111) === 0) {
        throw new Error(`[afterPack] ${rel} lost its exec bit while copying into ${dest}`);
      }
    }
  }
  console.log(
    `[afterPack] Copied DSH host artifact ${manifest.version} (DSH ${manifest.dsh}, ${built}) -> ${dest}`
  );
}

/**
 * Copy the Claude Agent SDK host artifact into resources/claude-sdk-host (route
 * B S-4, topic s4-packaging.md B-1): built by scripts/build-claude-sdk-host.mjs
 * for one platform, so the source and the copy are both verified against the
 * target being packaged (manifest, the target's CLI binary and its exec bit,
 * the size budget). Serial here for the same reason as copyDshHost.
 */
export function copyClaudeSdkHost(context) {
  const src = path.join(context.packager.info.projectDir, CLAUDE_SDK_HOST_OUT_REL);
  const platform = context.electronPlatformName;
  const arch = context.arch === undefined ? 'x64' : archToKey(context.arch);
  const target = { platform, arch };
  if (!fs.existsSync(src)) {
    throw new Error(
      `[afterPack] ${CLAUDE_SDK_HOST_OUT_REL} missing at ${src} — run "pnpm build:claude-sdk-host" first`
    );
  }
  try {
    verifyClaudeSdkHostArtifact({ outDir: src, target, requireManifest: true });
  } catch (error) {
    throw new Error(
      `[afterPack] ${CLAUDE_SDK_HOST_OUT_REL} is not packageable for ${platform}-${arch}: ${error.message}`
    );
  }
  const dest = path.join(resolveResourcesDir(context), 'claude-sdk-host');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const copied = verifyClaudeSdkHostArtifact({ outDir: dest, target, requireManifest: true });
  console.log(
    `[afterPack] Copied Claude SDK host artifact (${platform}-${arch}, ${copied.files} files, ` +
      `${(copied.bytes / 1024 / 1024).toFixed(1)} MiB) -> ${dest}`
  );
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
 * Serial afterPack copy for the same rcedit-race reason as copyDshHost.
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

  const dest = path.join(resolveResourcesDir(context), 'node-runtime');
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

/** Resolve Electron's platform-specific resources directory. */
export function resolveResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return path.join(context.appOutDir, 'resources');
  }
  const productFilename = context.packager.appInfo.productFilename;
  if (!productFilename) throw new Error('[afterPack] missing macOS product filename');
  return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
}

/** electron-builder's Arch enum -> the arch half of our pin keys. */
export function archToKey(arch) {
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
