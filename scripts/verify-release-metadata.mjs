#!/usr/bin/env node
/** Static T37 release-document and legal-notice gate. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
]) {
  if (!builder.includes(required)) failures.push(`electron-builder.yml missing: ${required}`);
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

console.log('[verify-release-metadata] PASS — notices, migration, rollback, and release workflow');
