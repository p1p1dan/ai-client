import type { SearchMode } from '@/components/search/useGlobalSearch';
import { matchesKeybinding } from '@/lib/keybinding';
import type { SearchKeybindings } from '@/stores/settings';

export function resolveWorkspaceSearchShortcut(
  event: KeyboardEvent,
  bindings: SearchKeybindings
): SearchMode | null {
  if (event.defaultPrevented || event.isComposing || event.repeat) return null;
  // Optional at runtime: a profile saved before chat search has no entry until migrated.
  if (bindings.searchChats && matchesKeybinding(event, bindings.searchChats)) return 'chat';
  if (matchesKeybinding(event, bindings.searchFiles)) return 'files';
  if (matchesKeybinding(event, bindings.searchContent)) return 'content';
  return null;
}
