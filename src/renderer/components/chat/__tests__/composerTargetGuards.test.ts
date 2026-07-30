/**
 * T-27 source-scan guards: the easiest ways to accidentally re-break the
 * chat / workspace-shell boundary turned into vitest assertions instead of
 * relying on manual review every time.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(__dirname, '..');

/** Every .ts/.tsx source file under components/chat, excluding __tests__. */
function collectChatSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectChatSourceFiles(full));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = collectChatSourceFiles(CHAT_DIR);

function findMatches(pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8');
    if (pattern.test(content)) {
      offenders.push(path.relative(CHAT_DIR, file));
    }
  }
  return offenders;
}

/** Strip `/* *\/` and `//` comments so prose mentioning "import ..." can't be
 * mistaken for real import syntax below. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every `import ... from '...'` statement (including multi-line named
 * imports) in a file. Scoped to actual import syntax rather than raw text so
 * doc comments that *describe* the chat/workspace-shell boundary (which this
 * module and others intentionally have) don't trip the guard themselves.
 */
function collectImportStatements(content: string): string[] {
  return stripComments(content).match(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g) ?? [];
}

describe('no in-place checkout from the chat tree', () => {
  it('never references git.checkout / onCheckout / useGitCheckout under components/chat', () => {
    const offenders = findMatches(/git\.checkout|onCheckout|useGitCheckout/);
    expect(offenders).toEqual([]);
  });

  it('never imports BranchSelector', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content);
      if (imports.some((statement) => statement.includes('BranchSelector'))) {
        offenders.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('dependency direction', () => {
  it('components/chat never imports components/workspace-shell', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content);
      if (imports.some((statement) => statement.includes('workspace-shell'))) {
        offenders.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('branch data source', () => {
  // T-27 review fix: the previous version of this guard scanned for the
  // string `getBranches` and special-cased `useComposerTarget.ts` — but the
  // actual `useGitBranches` call site lives in `TargetBranchSelect.tsx` (it
  // fetches the CreateWorktreeDialog's own base-branch picker; the branch
  // *menu* in the dropdown comes from the store via `buildBranchMenu`,
  // T-27 decision #5). The old assertions never matched real source and
  // would have stayed green through a regression. Rewritten to scan actual
  // `useGitBranches` import/call sites instead of a stale filename.

  it('useGitBranches is imported by exactly one file under components/chat: TargetBranchSelect.tsx', () => {
    const importers: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content);
      if (imports.some((statement) => statement.includes('useGitBranches'))) {
        importers.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(importers).toEqual(['TargetBranchSelect.tsx']);
  });

  it('TargetBranchSelect.tsx gates its useGitBranches call on worktreeDialogOpen via `enabled:`', () => {
    const file = sourceFiles.find(
      (candidate) => path.basename(candidate) === 'TargetBranchSelect.tsx'
    );
    expect(file).toBeDefined();

    const lines = readFileSync(file as string, 'utf8').split('\n');
    const callLineIndex = lines.findIndex((line) => /useGitBranches\s*\(/.test(line));
    expect(callLineIndex).toBeGreaterThanOrEqual(0);

    // `enabled:` and the guarding variable may sit on the call line itself or
    // spill onto the next couple of lines for a multi-line call — scan a
    // small window (call line + 3) instead of requiring an exact line match.
    const window = lines.slice(callLineIndex, callLineIndex + 4).join('\n');
    expect(window).toMatch(/enabled\s*:/);
    expect(window).toMatch(/worktreeDialogOpen/);
  });
});
