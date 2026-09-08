#!/usr/bin/env node
/** Static T37 release-document and legal-notice gate. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCredentialKeys } from './refresh-model-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing required release file: ${relativePath}`);
    return '';
  }
  const content = fs.readFileSync(absolutePath, 'utf8');
  if (!content.trim()) failures.push(`required release file is empty: ${relativePath}`);
  return content;
}

const notices = read('THIRD_PARTY_NOTICES.md');
for (const required of [
  'Copyright (c) 2026 justhil',
  'Copyright (c) 2026 Num Scope',
  'Copyright (c) 2025 Mario Zechner',
  '@earendil-works/pi-coding-agent',
]) {
  if (!notices.includes(required)) failures.push(`third-party notices missing: ${required}`);
}

for (const requiredPath of [
  'LICENSE',
  'docs/pi-only-migration.md',
  'docs/pi-only-rollout-rollback.md',
  'docs/release-notes/unreleased.md',
]) {
  read(requiredPath);
}

const builder = read('electron-builder.yml');
for (const required of [
  'from: LICENSE',
  'to: licenses/LICENSE',
  'from: THIRD_PARTY_NOTICES.md',
  'to: licenses/THIRD_PARTY_NOTICES.md',
  // A3: the offline model catalog baseline has to reach the artifact. Without
  // this entry the snapshot exists only in the repository, and a packaged build
  // silently loses its fallback for "management endpoint unreachable".
  'from: resources/model-catalog/snapshot.json',
  'to: model-catalog/snapshot.json',
]) {
  if (!builder.includes(required)) failures.push(`electron-builder.yml missing: ${required}`);
}

/**
 * A3 — the bundled catalog snapshot, checked statically because it is packaged.
 *
 * Deliberately NOT a fetch: refreshing the catalog needs a client API key and a
 * reachable management endpoint, so wiring it into `dist:prereq` would make
 * every offline or CI build fail on a credential it has no business holding.
 * The refresh is a human release step (`pnpm refresh:model-catalog`); this gate
 * only checks that whatever is committed is well-formed and carries no
 * credentials, since the file ships world-readable inside the package.
 */
const snapshotPath = 'resources/model-catalog/snapshot.json';
const snapshotText = read(snapshotPath);
if (snapshotText) {
  try {
    const snapshot = JSON.parse(snapshotText);
    if (snapshot?.version !== 1) failures.push(`${snapshotPath}: version must be 1`);
    if (!snapshot?.providers || typeof snapshot.providers !== 'object') {
      failures.push(`${snapshotPath}: providers must be an object`);
    }
    // A zero-model snapshot is read as no snapshot at all, so shipping one
    // would disarm the offline fallback while every other check still passed.
    // Checked at release time only: an empty placeholder is a legitimate state
    // for a working tree whose management endpoint is not deployed yet.
    const modelCount = Object.values(snapshot?.providers ?? {}).reduce(
      (sum, provider) => sum + (Array.isArray(provider?.models) ? provider.models.length : 0),
      0
    );
    if (modelCount === 0) {
      failures.push(
        `${snapshotPath}: carries no models, so the offline catalog fallback would be inert — run \`pnpm refresh:model-catalog\``
      );
    }

    // Reuses the release script's scanner rather than a second regex: a plain
    // key-name match would fire on every provider's `credentials.apiKey`, which
    // states WHERE the key comes from and never carries one.
    const credentials = findCredentialKeys(snapshot);
    if (credentials.length > 0) {
      failures.push(
        `${snapshotPath}: carries credential-shaped keys and must not be packaged: ${credentials.join(', ')}`
      );
    }
  } catch (error) {
    failures.push(`${snapshotPath}: invalid JSON (${error.message})`);
  }
}

const workflow = read('.github/workflows/build.yml');
for (const required of [
  'build-macos:',
  'Generate curated release notes',
  'docs/release-notes/unreleased.md',
]) {
  if (!workflow.includes(required)) failures.push(`Build workflow missing: ${required}`);
}
if (fs.existsSync(path.join(repoRoot, '.github', 'workflows', 'release-notes.yml'))) {
  failures.push('standalone release-notes.yml would compete with the Build workflow');
}

if (failures.length > 0) {
  console.error(`[verify-release-metadata] FAIL\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(
  '[verify-release-metadata] PASS — notices, migration, rollback, release workflow, model catalog snapshot'
);
