/**
 * Layout 5b: a keybinding as the sidebar's 「搜索」 entry shows it, faintly at
 * the right. Pure; the platform is passed in.
 *
 * `meta` is named for what it is on each platform — the search bindings
 * default to it (`defaultSearchKeybindings`), and printing 「Ctrl」 for a key
 * that is really Win / Super would send the user to the wrong chord.
 */
import type { TerminalKeybinding } from '@/stores/settings';

export function keybindingLabel(binding: TerminalKeybinding, platform: string): string {
  const mac = platform === 'darwin';
  const parts: string[] = [];
  if (binding.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
  if (binding.alt) parts.push(mac ? '⌥' : 'Alt');
  if (binding.shift) parts.push(mac ? '⇧' : 'Shift');
  if (binding.meta) parts.push(mac ? '⌘' : platform === 'win32' ? 'Win' : 'Super');
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  parts.push(key);
  return parts.join(mac ? '' : '+');
}
