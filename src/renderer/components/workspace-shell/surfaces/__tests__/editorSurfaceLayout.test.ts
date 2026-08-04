import { describe, expect, it } from 'vitest';
import {
  EDITOR_MIN_WIDTH,
  EDITOR_SPLIT_MIN,
  EDITOR_TREE_WIDTH,
  resolveEditorSurfaceLayout,
} from '../editorSurfaceLayout';

describe('editorSurfaceLayout constants', () => {
  it('pins the spec values', () => {
    expect(EDITOR_TREE_WIDTH).toBe(220);
    expect(EDITOR_MIN_WIDTH).toBe(480);
    expect(EDITOR_SPLIT_MIN).toBe(704);
  });
});

describe('resolveEditorSurfaceLayout', () => {
  it('is always tree-only with no open tab, regardless of width or the tree toggle', () => {
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 1200, hasOpenTab: false, treeRequested: true })
    ).toBe('tree-only');
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 1200, hasOpenTab: false, treeRequested: false })
    ).toBe('tree-only');
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 380, hasOpenTab: false, treeRequested: false })
    ).toBe('tree-only');
  });

  it('splits when wide enough and the tree is requested', () => {
    expect(
      resolveEditorSurfaceLayout({
        panelWidth: EDITOR_SPLIT_MIN,
        hasOpenTab: true,
        treeRequested: true,
      })
    ).toBe('split');
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 1200, hasOpenTab: true, treeRequested: true })
    ).toBe('split');
  });

  it('is editor-only when wide enough but the tree is not requested', () => {
    expect(
      resolveEditorSurfaceLayout({
        panelWidth: EDITOR_SPLIT_MIN,
        hasOpenTab: true,
        treeRequested: false,
      })
    ).toBe('editor-only');
  });

  it('just below the split threshold is editor-only even when the tree is requested', () => {
    // Regression guard: this must NOT be 'tree-only' — that would strand an
    // open tab, since the toggle to get back to the editor lives inside
    // EditorArea's own chrome (unmounted in 'tree-only').
    const panelWidth = EDITOR_SPLIT_MIN - 1;
    expect(resolveEditorSurfaceLayout({ panelWidth, hasOpenTab: true, treeRequested: true })).toBe(
      'editor-only'
    );
    expect(resolveEditorSurfaceLayout({ panelWidth, hasOpenTab: true, treeRequested: false })).toBe(
      'editor-only'
    );
  });

  it('stays editor-only with an open tab at any narrower width, tree requested or not', () => {
    expect(
      resolveEditorSurfaceLayout({
        panelWidth: EDITOR_MIN_WIDTH,
        hasOpenTab: true,
        treeRequested: true,
      })
    ).toBe('editor-only');
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 0, hasOpenTab: true, treeRequested: true })
    ).toBe('editor-only');
    expect(
      resolveEditorSurfaceLayout({ panelWidth: 380, hasOpenTab: true, treeRequested: false })
    ).toBe('editor-only');
  });
});
