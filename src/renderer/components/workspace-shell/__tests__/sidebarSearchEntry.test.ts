import { describe, expect, it, vi } from 'vitest';
import { defaultSearchKeybindings } from '@/stores/settings/defaults';
import { sidebarSearchEntry } from '../sidebar/sidebarSearchEntry';

describe('the sidebar 「搜索」 entry (chat search)', () => {
  it('is enabled without a workspace and shows the chat search shortcut', () => {
    const onOpen = vi.fn();
    const entry = sidebarSearchEntry(onOpen, defaultSearchKeybindings.searchChats, 'linux');
    expect(entry.enabled).toBe(true);
    expect(entry.shortcut).toBe('Shift+Super+K');
    entry.onOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows no shortcut for a profile that has none yet', () => {
    expect(sidebarSearchEntry(() => undefined, undefined, 'win32').shortcut).toBe('');
  });

  it('opens the dialog on the chats tab from the shell', async () => {
    const { readFileSync } = await import('node:fs');
    const shell = readFileSync(new URL('../WorkspaceShell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain("onOpenSearch={() => workspaceSearch.openSearch('chat')}");
  });
});
