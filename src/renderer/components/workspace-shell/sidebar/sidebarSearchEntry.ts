/**
 * The sidebar's 「搜索」 entry (layout 5b). Chat search (stage 3) made it open
 * the search dialog on its 「对话」 tab, which needs no workspace, so the
 * entry is always enabled; its shortcut is the chat search binding.
 */
import type { TerminalKeybinding } from '@/stores/settings';
import type { SidebarSearchEntry } from '../LeftNav';
import { keybindingLabel } from './keybindingLabel';

export function sidebarSearchEntry(
  onOpen: () => void,
  binding: TerminalKeybinding | undefined,
  platform: string
): SidebarSearchEntry {
  return {
    onOpen,
    enabled: true,
    shortcut: binding ? keybindingLabel(binding, platform) : '',
  };
}
