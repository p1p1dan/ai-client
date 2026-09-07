import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SearchKeybindings } from '@/stores/settings';
import { resolveWorkspaceSearchShortcut } from '../workspaceSearchShortcuts';

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'p',
    code: 'KeyP',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    ...overrides,
  } as KeyboardEvent;
}

const bindings: SearchKeybindings = {
  searchFiles: { key: 'p', ctrl: true },
  searchContent: { key: 'f', ctrl: true, shift: true },
};

describe('workspace search entry', () => {
  it('resolves file and content search using the saved bindings', () => {
    expect(resolveWorkspaceSearchShortcut(event(), bindings)).toBe('files');
    expect(
      resolveWorkspaceSearchShortcut(event({ key: 'F', code: 'KeyF', shiftKey: true }), bindings)
    ).toBe('content');
    const customized = { ...bindings, searchFiles: { key: 'k', meta: true } };
    expect(resolveWorkspaceSearchShortcut(event(), customized)).toBeNull();
    expect(
      resolveWorkspaceSearchShortcut(
        event({ key: 'k', code: 'KeyK', ctrlKey: false, metaKey: true }),
        customized
      )
    ).toBe('files');
  });

  it('does not intercept composition, repeat, handled events or different modifiers', () => {
    for (const overrides of [
      { isComposing: true },
      { repeat: true },
      { defaultPrevented: true },
      { altKey: true },
      { shiftKey: true },
      { ctrlKey: false },
    ]) {
      expect(resolveWorkspaceSearchShortcut(event(overrides), bindings)).toBeNull();
    }
  });

  it('keeps the dialog and shortcut owner mounted outside the active-only file surface', () => {
    const shell = readFileSync(new URL('../WorkspaceShell.tsx', import.meta.url), 'utf8');
    const files = readFileSync(
      new URL('../surfaces/FilesSurfaceView.tsx', import.meta.url),
      'utf8'
    );
    expect(shell).toContain('useWorkspaceSearch()');
    expect(shell).toContain('<GlobalSearchDialog');
    expect(shell).toContain('onSearch={workspaceSearch.openSearch}');
    expect(files).toContain("onSearch?.('files')");
    expect(files).toContain("onSearch?.('content')");
    expect(files).not.toContain("addEventListener('keydown'");
  });
});
