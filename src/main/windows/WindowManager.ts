import type { BrowserWindow } from 'electron';
import { createMainWindow } from './MainWindow';

export function openLocalWindow(options?: {
  replaceWindow?: BrowserWindow | null;
  /** Resolved OS/theme-setting dark flag, used for the initial paint (background color + renderer class). */
  isDark?: boolean;
}): BrowserWindow {
  return createMainWindow({
    replaceWindow: options?.replaceWindow ?? null,
    isDark: options?.isDark,
  });
}
