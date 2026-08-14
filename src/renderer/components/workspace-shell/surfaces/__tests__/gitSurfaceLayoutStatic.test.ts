import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../chat/__tests__/stripComments';

/**
 * D34 (2026-08-14): the docked git surface's `changesPane` is a strict
 * top/bottom 50/50 split — upper half (`ChangesList` + `CommitBox`), lower
 * half (`GitHistoryList`) — mirroring the VS Code SCM panel reference
 * (`docs/design/refs/vscode-20260814-gitxvqiu/vscode-scm-panel-graph-expand.png`).
 *
 * `GitSurfaceView.tsx` can't be mounted under vitest's `node` environment
 * (it transitively reaches Monaco via `DiffViewer`, same constraint
 * `editorSurfaceIntentGuards.test.ts` and `terminalSurfaceStatic.test.ts`
 * work around) — hence the static source scan instead of an RTL render.
 *
 * What this guards against: reverting `changesPane` to the pre-D34 shape,
 * where only the `ChangesList` wrapper carried `flex-1` and `GitHistoryList`
 * was a `shrink-0` block sized to its own content (collapsed to near-zero on
 * a clean workdir, `max-h-60`-capped otherwise). That regression is a single
 * class-string edit that no other test in this suite would catch.
 */

const ROOT = process.cwd();

function code(relativePath: string): { raw: string; flat: string } {
  const file = join(ROOT, relativePath);
  const raw = readFileSync(file, 'utf8');
  // Whitespace-flattened so the assertions survive any re-formatting.
  return { raw, flat: stripComments(raw, file).replace(/\s+/g, ' ') };
}

const VIEW = code('src/renderer/components/workspace-shell/surfaces/GitSurfaceView.tsx');

// Isolate `changesPane`'s own JSX from the rest of the file (the `diffPane`
// const and the `split`/`diff`/list-returning branches below it use their own
// unrelated `flex-1` wrappers, which would otherwise dilute a whole-file scan).
const CHANGES_PANE_START = VIEW.flat.indexOf('const changesPane = (');
const DIFF_PANE_START = VIEW.flat.indexOf('const diffPane = (');
const CHANGES_PANE = VIEW.flat.slice(CHANGES_PANE_START, DIFF_PANE_START);

describe('GitSurfaceView changesPane: docked 50/50 top/bottom split (D34)', () => {
  it('isolates a non-empty changesPane slice to scan', () => {
    expect(CHANGES_PANE_START).toBeGreaterThan(-1);
    expect(DIFF_PANE_START).toBeGreaterThan(CHANGES_PANE_START);
  });

  it('gives both halves the same flex-1 flex-col wrapper — neither is shrink-0 or content-sized', () => {
    const halfWrapper = /flex min-h-0 flex-1 flex-col/g;
    const matches = CHANGES_PANE.match(halfWrapper) ?? [];
    // Exactly two: the upper half (ChangesList + CommitBox) and the lower
    // half (GitHistoryList). A third would mean a half got wrapped twice; one
    // would mean the split collapsed back to a single flexible region.
    expect(matches).toHaveLength(2);
  });

  it('the upper half wraps ChangesList and CommitBox, not GitHistoryList', () => {
    const upperHalfEnd = CHANGES_PANE.indexOf('<GitHistoryList');
    expect(upperHalfEnd).toBeGreaterThan(-1);
    const upperHalf = CHANGES_PANE.slice(0, upperHalfEnd);
    expect(upperHalf).toContain('<ChangesList');
    expect(upperHalf).toContain('<CommitBox');
  });

  it('the lower half is its own bordered flex-1 region, and it is the one wrapping GitHistoryList', () => {
    const lowerHalfStart = CHANGES_PANE.indexOf('flex min-h-0 flex-1 flex-col border-t');
    expect(lowerHalfStart).toBeGreaterThan(-1);
    const afterLowerHalf = CHANGES_PANE.slice(lowerHalfStart);
    expect(afterLowerHalf.indexOf('<GitHistoryList')).toBeGreaterThan(-1);
    // The bordered wrapper must be the one immediately enclosing
    // GitHistoryList, not some unrelated element earlier in the pane.
    expect(afterLowerHalf.indexOf('<GitHistoryList')).toBeLessThan(100);
  });

  it('never falls back to the pre-D34 shape — GitHistoryList sized to its own content instead of a flex-1 half', () => {
    // Pre-D34, GitHistoryList rendered as a bare sibling with no flex-1
    // wrapper of its own — it just sat after CommitBox in the shared column.
    // A regression back to that shape would still pass "contains
    // <GitHistoryList" but fail to enclose it in the second flex-1 wrapper.
    const secondWrapperIndex = CHANGES_PANE.indexOf(
      'flex min-h-0 flex-1 flex-col',
      CHANGES_PANE.indexOf('flex min-h-0 flex-1 flex-col') + 1
    );
    const historyIndex = CHANGES_PANE.indexOf('<GitHistoryList');
    expect(secondWrapperIndex).toBeGreaterThan(-1);
    expect(secondWrapperIndex).toBeLessThan(historyIndex);
  });
});
