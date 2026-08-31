import fs from 'node:fs';
import path from 'node:path';

import { serializeDefaultPermissionPolicy } from '../src/agent-host/permissionPolicy.mjs';

export const ESBUILD_EXTERNAL = ['@earendil-works/pi-coding-agent'];

export const REQUIRED_WORKER_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@gotgenes/pi-permission-system',
];

export const OBSOLETE_EXECUTION_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@cometix/claude-code',
  '@openai/codex',
  'node-pty',
];

export const LICENSE_BEARING_PACKAGES = new Set([
  '@gotgenes/pi-permission-system',
  'tree-sitter-bash',
  'web-tree-sitter',
  'zod',
]);

export const BUNDLED_PERMISSION_POLICY_REL =
  'node_modules/@gotgenes/pi-permission-system/config.json';
export const DEV_AGENT_HOST_DIR_REL = 'src/agent-host';

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function topPackage(parts) {
  return parts[0]?.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packagePathMatches(rel, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|/node_modules/)${escaped}(?:/|$|-)`).test(rel);
}

export function containsObsoleteExecutionPackage(rel) {
  return OBSOLETE_EXECUTION_PACKAGES.some((name) => packagePathMatches(rel, name));
}

export function preflightHostDeps({ root }) {
  const hostRoot = path.join(root, 'src', 'agent-host');
  const hostNodeModules = path.join(hostRoot, 'node_modules');
  if (!fs.existsSync(hostNodeModules)) {
    throw new Error(`missing ${hostNodeModules} — run "npm install" in src/agent-host first`);
  }

  const manifest = readJson(path.join(hostRoot, 'package.json'));
  const installed = {};
  for (const name of REQUIRED_WORKER_PACKAGES) {
    const declared = manifest.dependencies?.[name];
    if (!declared) throw new Error(`src/agent-host/package.json does not declare ${name}`);
    if (/^[~^]/.test(declared)) {
      throw new Error(`${name} must be an exact worker runtime pin, got "${declared}"`);
    }
    const packageJson = path.join(hostNodeModules, ...name.split('/'), 'package.json');
    if (!fs.existsSync(packageJson)) throw new Error(`${name} is not installed`);
    installed[name] = readJson(packageJson).version;
  }
  return { installed };
}

export function isLicenseFileName(base) {
  return /^licen[cs]e(\.|$)/i.test(base);
}

export function findLicenseFile(packageDir) {
  if (!fs.existsSync(packageDir)) return null;
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && isLicenseFileName(entry.name)) return entry.name;
  }
  return null;
}

function isCurrentSharpVariant(top, platform, arch) {
  if (!top?.startsWith('@img/')) return true;
  if (platform === 'linux')
    return top.endsWith(`-linux-${arch}`) || top.endsWith(`-linuxmusl-${arch}`);
  return top.endsWith(`-${platform}-${arch}`);
}

export function shouldCopy(rel, { platform, arch }) {
  if (rel === '') return true;
  const parts = rel.split('/');
  const top = topPackage(parts);
  const base = parts.at(-1) ?? '';

  if (parts[0] === '.bin' || parts[0] === '.package-lock.json') return false;
  if (containsObsoleteExecutionPackage(rel)) return false;
  if (!isCurrentSharpVariant(top, platform, arch)) return false;

  if (top === '@gotgenes/pi-permission-system') {
    if (rel.includes('/docs/')) return false;
    if (/^(README|CHANGELOG)\./i.test(base)) return false;
    return true;
  }

  if (top === 'tree-sitter-bash') {
    if (parts.length === 1) return true;
    if (parts.length !== 2) return false;
    return base === 'package.json' || base.endsWith('.wasm') || isLicenseFileName(base);
  }

  if (isLicenseFileName(base)) return true;
  if (
    base.endsWith('.d.ts') ||
    base.endsWith('.d.mts') ||
    base.endsWith('.d.cts') ||
    base.endsWith('.map') ||
    base.endsWith('.md')
  ) {
    return false;
  }
  if (
    parts.includes('docs') ||
    parts.includes('test') ||
    parts.includes('tests') ||
    parts.includes('__tests__')
  ) {
    return false;
  }
  return true;
}

export function writeBundledPermissionPolicy(outDir) {
  const target = path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/'));
  if (!fs.existsSync(path.dirname(target))) {
    throw new Error(
      `cannot write the permission policy: ${path.dirname(target)} is missing — the plugin did not survive the copy`
    );
  }
  fs.writeFileSync(target, serializeDefaultPermissionPolicy());
  return target;
}

export function ensureDevPermissionPolicy(repoRoot) {
  const outDir = path.join(repoRoot, ...DEV_AGENT_HOST_DIR_REL.split('/'));
  const pluginDir = path.dirname(path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/')));
  if (!fs.existsSync(pluginDir)) {
    return { written: false, reason: `${pluginDir} is missing — run pnpm install` };
  }
  return { written: true, path: writeBundledPermissionPolicy(outDir) };
}

export function verifyBundledPermissionPolicy(outDir) {
  const target = path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/'));
  if (!fs.existsSync(target)) return [`missing ${BUNDLED_PERMISSION_POLICY_REL}`];
  let parsed;
  try {
    parsed = readJson(target);
  } catch (error) {
    return [`${BUNDLED_PERMISSION_POLICY_REL} is not valid JSON: ${error.message}`];
  }
  const failures = [];
  const permission = parsed.permission ?? {};
  if (permission['*'] !== 'ask') failures.push('shipped policy: permission["*"] must be "ask"');
  if (permission.bash?.['*'] !== 'ask') {
    failures.push('shipped policy: permission.bash["*"] must be "ask"');
  }
  if (permission.external_directory?.['*'] !== 'ask') {
    failures.push('shipped policy: permission.external_directory["*"] must be "ask"');
  }
  if (parsed.yoloMode !== false) failures.push('shipped policy: yoloMode must be false');
  return failures;
}

function walkRelativeFiles(root, rel = '', found = []) {
  const dir = rel ? path.join(root, ...rel.split('/')) : root;
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkRelativeFiles(root, child, found);
    else found.push(child);
  }
  return found;
}

export function verifyArtifact({ outDir }) {
  const failures = [];
  const abs = (rel) => path.join(outDir, ...rel.split('/'));
  const mustExist = (rel, note) => {
    if (!fs.existsSync(abs(rel))) failures.push(`missing ${rel}${note ? ` (${note})` : ''}`);
  };
  const mustNotExist = (rel, note) => {
    if (fs.existsSync(abs(rel))) failures.push(`must not ship ${rel}${note ? ` (${note})` : ''}`);
  };

  for (const rel of [
    'worker.js',
    'package.json',
    'node_modules/@earendil-works/pi-coding-agent/package.json',
    'node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    'node_modules/@gotgenes/pi-permission-system/package.json',
    'node_modules/@gotgenes/pi-permission-system/src/index.ts',
    'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
  ]) {
    mustExist(rel);
  }

  mustNotExist('index.js', 'legacy Agent Host entry');
  mustNotExist('piHost.js', 'singleton Pi transition entry');
  mustNotExist('node_modules/.bin', 'npm bin symlink directory');
  failures.push(...verifyBundledPermissionPolicy(outDir));

  const files = walkRelativeFiles(path.join(outDir, 'node_modules'));
  for (const rel of files) {
    if (containsObsoleteExecutionPackage(rel)) {
      failures.push(`must not ship node_modules/${rel} (obsolete execution payload)`);
    }
  }

  for (const name of LICENSE_BEARING_PACKAGES) {
    const packageDir = abs(`node_modules/${name}`);
    if (fs.existsSync(packageDir) && !findLicenseFile(packageDir)) {
      failures.push(`node_modules/${name} ships without a licence file`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`artifact verification failed:\n  - ${failures.join('\n  - ')}`);
  }
  return { totalBytes: dirSize(outDir) };
}
