import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../chat/__tests__/stripComments';

/**
 * D34-E: git diff pages moved from an in-panel `DiffViewer` branch to a
 * center-column tab (same open-mode `EditorColumn.tsx` already uses for a
 * file, T-32/T-13). `EditorArea.tsx` (Monaco) and `GitSurfaceView.tsx`
 * (transitively, via `DiffViewer`'s own Monaco `DiffEditor`) both reach
 * Monaco's `monacoSetup` top-level `await loader.init()`, so neither can be
 * `import`ed under vitest's `node` environment — same constraint
 * `editorSurfaceIntentGuards.test.ts` and `gitSurfaceLayoutStatic.test.ts`
 * already work around. Hence the static scan.
 */

const ROOT = process.cwd();

function code(relativePath: string): { raw: string; flat: string } {
  const file = join(ROOT, relativePath);
  const raw = readFileSync(file, 'utf8');
  return { raw, flat: stripComments(raw, file).replace(/\s+/g, ' ') };
}

const EDITOR_AREA = code('src/renderer/components/files/EditorArea.tsx');
const EDITOR_COLUMN = code('src/renderer/components/workspace-shell/center/EditorColumn.tsx');
const GIT_SURFACE = code('src/renderer/components/workspace-shell/surfaces/GitSurfaceView.tsx');

describe('EditorArea: diff tab body branch', () => {
  it('renders DiffViewer for a diff tab', () => {
    expect(EDITOR_AREA.flat).toContain('activeTab.diffTarget ? ( <DiffViewer');
  });

  // Mutation check: swapping this branch order (checking isUnsupported/isImage/
  // isPdf BEFORE diffTarget) would let a diffed image/pdf/unsupported file's
  // OWN extension-sniffing intercept a diff tab before DiffViewer ever
  // mounts — the diffTarget check must be the FIRST arm of the ternary.
  it('checks diffTarget before isUnsupported/isImage/isPdf (first arm of the ternary)', () => {
    const diffIdx = EDITOR_AREA.flat.indexOf('activeTab.diffTarget ? (');
    const unsupportedIdx = EDITOR_AREA.flat.indexOf('activeTab.isUnsupported ? (');
    expect(diffIdx).toBeGreaterThan(-1);
    expect(unsupportedIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeLessThan(unsupportedIdx);
  });

  it('skips the breadcrumb row for a diff tab (its path is a pseudo path, not a real fs location)', () => {
    expect(EDITOR_AREA.flat).toContain('if (!activeTabPath || !rootPath || isDiffTab) return [];');
  });

  it('never treats a diff tab as markdown (no preview toggle, no split-preview panel)', () => {
    expect(EDITOR_AREA.flat).toContain('isMarkdownFile(activeTabPath) && !isDiffTab');
  });

  it('drives a commit diff tab from its own useCommitDiff query, skipFetch + isCommitView, like GitSurfaceView does', () => {
    expect(EDITOR_AREA.flat).toContain("kind === 'commit' ? { diff: commitDiffQuery.data");
    expect(EDITOR_AREA.flat).toContain('skipFetch: true');
    expect(EDITOR_AREA.flat).toContain('isCommitView: true');
  });
});

describe('EditorColumn: diff tabs cost nothing extra, no refresh on a pseudo path', () => {
  it('the "no tabs" mount guard is untouched — diff tabs live in the SAME tabs array', () => {
    expect(EDITOR_COLUMN.flat).toContain('if (tabs.length === 0 || !rootPath) { return null; }');
  });

  it('skips refreshFileContent (a real fs read) for a diff tab on tab click', () => {
    expect(EDITOR_COLUMN.flat).toContain('if (!tab?.diffTarget) { refreshFileContent(path); }');
  });
});

describe('GitSurfaceView: file clicks open a center diff tab (D34-E)', () => {
  it('handleFileClick opens a workdir diff tab', () => {
    const start = GIT_SURFACE.flat.indexOf('const handleFileClick = useCallback(');
    const end = GIT_SURFACE.flat.indexOf('const handleToggleHistory');
    expect(start).toBeGreaterThan(-1);
    const body = GIT_SURFACE.flat.slice(start, end);
    expect(body).toContain("dispatch({ type: 'select', file });");
    expect(body).toContain("kind: 'workdir'");
    expect(body).toContain('openDiffTab(target);');
  });

  it('handleSelectCommitFile opens a commit diff tab', () => {
    const start = GIT_SURFACE.flat.indexOf('const handleSelectCommitFile = useCallback(');
    const end = GIT_SURFACE.flat.indexOf('const handleStage');
    expect(start).toBeGreaterThan(-1);
    const body = GIT_SURFACE.flat.slice(start, end);
    expect(body).toContain("dispatch({ type: 'select-commit-file', file });");
    expect(body).toContain("kind: 'commit'");
    expect(body).toContain('openDiffTab(target);');
  });

  // Mutation pair: this is the "点文件不再进面板内 diff 分支" pin. Reverting
  // GitSurfaceView.tsx to the pre-D34-E shape (restoring either takeover
  // branch, e.g. `if (state.selectedCommitFile) { return (` or
  // `if (presentation === 'diff') {`) must turn this red — verified by hand
  // (temporarily restoring the branch locally) while landing this batch.
  it('retired the in-panel selectedCommitFile full-pane DiffViewer takeover', () => {
    expect(GIT_SURFACE.flat).not.toContain('if (state.selectedCommitFile) {');
  });

  it('retired the in-panel single-view push-navigation diff branch', () => {
    expect(GIT_SURFACE.flat).not.toContain("if (presentation === 'diff') {");
  });

  it("expanded's split diffPane is untouched — still driven by state.selection, still a DiffViewer mount", () => {
    expect(GIT_SURFACE.flat).toContain("if (presentation === 'split') {");
    expect(GIT_SURFACE.flat).toContain('const diffPane = (');
    expect(GIT_SURFACE.flat).toContain('file={state.selection}');
  });

  it('gates the workdir-diff live query on expanded too, so it does not poll for a pane nothing renders', () => {
    expect(GIT_SURFACE.flat).toContain("enabled: surfaceActive && expanded && view === 'diff'");
  });
});
