/**
 * T-27 source-scan guards: the easiest ways to accidentally re-break the
 * chat / workspace-shell boundary turned into vitest assertions instead of
 * relying on manual review every time.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decideTargetChange } from '../composerTarget';
import { stripComments } from './stripComments';

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

/**
 * Every `import ... from '...'` statement (including multi-line named
 * imports) in a file. Scoped to actual import syntax rather than raw text so
 * doc comments that *describe* the chat/workspace-shell boundary (which this
 * module and others intentionally have) don't trip the guard themselves.
 *
 * The strip is the shared, parser-backed one (see `./stripComments`); it takes
 * the file's NAME because `.ts` and `.tsx` are different grammars. The private
 * regex pair this used to call could delete a whole line of real code whenever
 * a string, a template literal or a regex literal happened to contain `//` —
 * and an import statement that has been deleted is an import statement the
 * guards below cannot find.
 */
function collectImportStatements(content: string, file: string): string[] {
  return stripComments(content, file).match(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g) ?? [];
}

/**
 * The chat tree has exactly ONE in-place checkout, and this is it.
 *
 * T-27 (2026-07-29) banned checkout from `components/chat` outright, because the
 * row's model was "a branch is a property of a worktree": switching branch meant
 * switching to the workspace that had it checked out, so an in-place checkout
 * would have given `ChatWorkspace.branch` a second source and broken the
 * "display value is always derived from `workspaceId`, never stored" rule.
 *
 * 2026-09-24 the worktree concept was dropped from the row by user ruling
 * (worktrees are not needed here for now; use the default checkout). With no
 * worktree to switch to,
 * an in-place `git checkout` is the only way left to answer "switch this chat's
 * branch" — and the alternative that was tried (a second switcher in the shell
 * status bar) built a parallel copy of the same data outside this boundary.
 *
 * The ban is therefore narrowed rather than deleted: the boundary still exists,
 * and it is still worth a red test, but it now admits one named entry point.
 * Everything else under `components/chat` must go through it so the two locks
 * below cannot be bypassed by a second call site.
 */
describe('no in-place checkout from the chat tree', () => {
  it('references useGitCheckout in exactly one file, BranchColumn.tsx', () => {
    const offenders = findMatches(/git\.checkout|onCheckout|useGitCheckout/);
    expect(offenders).toEqual(['BranchColumn.tsx']);
  });

  it('BranchColumn.tsx is the only chat file that may name the checkout IPC', () => {
    // The single entry point is what carries the two locks
    // (`session-running` / `checkout-busy`, see composerColumns.ts). A second
    // call site would be a switch with neither.
    const columnPath = path.join(CHAT_DIR, 'BranchColumn.tsx');
    const column = stripComments(readFileSync(columnPath, 'utf8'), columnPath);
    expect(column).toContain('useGitCheckout');
    expect(column).toContain('column.lock');
  });

  it('never imports BranchSelector', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content, file);
      if (imports.some((statement) => statement.includes('BranchSelector'))) {
        offenders.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The branch column's fallback checkout is the composer TARGET, not the
 * repository column's entry. That entry is the repository default (it prefers
 * `main`), so when the target is a worktree the column would show and switch
 * main's branch while the conversation starts in the worktree. The wiring sits
 * in a component that no unit test mounts, so the guard reads it.
 */
describe('the branch column switches the checkout the conversation uses', () => {
  const barPath = path.join(CHAT_DIR, 'ComposerTargetBar.tsx');
  const bar = stripComments(readFileSync(barPath, 'utf8'), barPath);

  it('passes target.workspace as the fallback checkout', () => {
    expect(bar).toMatch(/fallbackWorkspaceId:\s*target\.workspace\?\.id\b/);
  });

  it('does not derive the fallback from the repository column', () => {
    expect(bar).not.toMatch(/fallbackWorkspaceId:\s*repoColumn/);
  });
});

describe('dependency direction', () => {
  it('components/chat never imports components/workspace-shell', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content, file);
      if (imports.some((statement) => statement.includes('workspace-shell'))) {
        offenders.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * T091 — `decideTargetChange` blocks on a send, and it must be THIS session's.
 *
 * The rule itself is unchanged and correct: you cannot re-point a chat at a
 * different folder while its own turn is being dispatched. What was wrong was
 * the input. `ChatComposer`'s latch used to be a bare boolean that is true while
 * ANY session's send is in flight, so a brand-new chat created during another
 * session's handshake had its whole target bar frozen — folder picker, branch
 * picker, everything — over a turn it has nothing to do with.
 *
 * The decision function has no way to notice: it is handed one boolean and must
 * trust it. So the guard has to live on the WIRING, and it is a chain of three
 * hops (composer -> ComposerTargetBar -> useComposerTarget -> decideTargetChange)
 * that no single unit test spans.
 */
describe('the target-change block is scoped to this session (T091)', () => {
  const composerPath = path.join(CHAT_DIR, 'ChatComposer.tsx');
  const composer = stripComments(readFileSync(composerPath, 'utf8'), composerPath);
  const hookPath = path.join(CHAT_DIR, 'useComposerTarget.ts');
  const hook = stripComments(readFileSync(hookPath, 'utf8'), hookPath);

  it('the target bar is fed the per-session latch, in both composer modes', () => {
    // Two instances, one per mode (empty / session) — never both at once, but
    // both must be scoped.
    expect(composer.match(/sending=\{sendingHere\}/g) ?? []).toHaveLength(3);
    expect(composer).not.toContain('sending={sending}');
  });

  it('useComposerTarget forwards that value into the rule without widening it', () => {
    // Both consumers of the three-tier rule inside the hook — the render-time
    // `blocked` derivation and the click-time plan — take the SAME input, so
    // the bar cannot look enabled and then refuse the click (or the reverse).
    expect(hook.match(/sending: input\.sending,/g) ?? []).toHaveLength(2);
    // No second source: the hook must not reach into a store for a send flag
    // of its own.
    expect(hook).not.toContain('sendInFlightSessionId');
    expect(hook).not.toContain('useTurnSendStatusStore');
  });

  it('the /new slash command asks the same question, about the same session', () => {
    // The one reader that was already correct before T091, and the shape every
    // other one now matches: the synchronous latch AND an identity check
    // against the session the command was typed into.
    expect(composer).toContain(
      'inFlightRef.current && inFlightSessionIdRef.current === activeSessionId'
    );
  });

  it('a send belonging to ANOTHER session leaves this one retargetable', () => {
    // What the wiring above buys, stated as behaviour: the fresh empty chat the
    // user just created is idle, has no messages and is not host-bound, so with
    // `sending: false` (the other session owns that send) it retargets. Passing
    // the global latch here — the pre-T091 wiring — is the `blocked` row below,
    // i.e. a target bar frozen by someone else's turn.
    expect(
      decideTargetChange({ status: 'idle', messageCount: 0, hostBound: false, sending: false })
    ).toBe('retarget');
    expect(
      decideTargetChange({ status: 'idle', messageCount: 0, hostBound: false, sending: true })
    ).toBe('blocked');
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
  //
  // 2026-09-24: `TargetBranchSelect.tsx` was deleted with the worktree concept,
  // so the only remaining call site is the branch column. The assertions now
  // name it, and pin the `skipMerged` flag that keeps a permanently-mounted
  // picker off the `gh pr list` shell-out.

  it('useGitBranches is imported by exactly one file under components/chat: BranchColumn.tsx', () => {
    const importers: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const imports = collectImportStatements(content, file);
      if (imports.some((statement) => statement.includes('useGitBranches'))) {
        importers.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(importers).toEqual(['BranchColumn.tsx']);
  });

  it('BranchColumn.tsx passes skipMerged, keeping the mounted picker off gh pr list', () => {
    const file = sourceFiles.find((candidate) => path.basename(candidate) === 'BranchColumn.tsx');
    expect(file).toBeDefined();

    const lines = readFileSync(file as string, 'utf8').split('\n');
    const callLineIndex = lines.findIndex((line) => /useGitBranches\s*\(/.test(line));
    expect(callLineIndex).toBeGreaterThanOrEqual(0);

    // `skipMerged` may sit on the call line or spill onto the next couple of
    // lines for a multi-line call — scan a small window rather than requiring
    // an exact line match.
    const window = lines.slice(callLineIndex, callLineIndex + 4).join('\n');
    expect(window).toContain('skipMerged: true');
  });
});
