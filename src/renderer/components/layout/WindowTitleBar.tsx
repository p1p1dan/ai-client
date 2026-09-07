import logoImage from '@/assets/logo.png';
import { useI18n } from '@/i18n';
import { WindowControls } from './WindowControls';

// 平台检查在模块级别进行，避免在组件内部违反 Hooks 规则
const isMac = typeof window !== 'undefined' && window.electronAPI?.env?.platform === 'darwin';

/**
 * Custom title bar for frameless windows (Windows/Linux).
 *
 * D07: stripped back to what a title bar is for — identity, the app-level menu,
 * and the window buttons. The Settings button and the user/usage pill moved to
 * `LeftNav`'s footer, beside the Settings and Plugins entries already there:
 * they are workspace chrome, and stacking them here alongside two more controls
 * is what made this strip read as clutter.
 *
 * F09 finished that reduction: the overflow menu is gone too, and nothing
 * replaced it. Reload, Developer Tools, GitHub and Exit were removed outright
 * rather than moved (user ruling, 2026-09-07) — every one of them is already
 * reachable without this menu (F12 and Ctrl+R are the platform's own shortcuts,
 * Alt+F4 and the window buttons close the window), so the menu was a second
 * entry point to things that already had one, and a devtools item shipped in
 * the product chrome besides.
 *
 * The bell that the field request asked to put "in the `...` button's place"
 * did NOT land here. This component returns `null` on macOS, so a control that
 * lives only in it would be missing on one of the three shipped platforms; the
 * bell is in `UserFooterPill` instead, which exists everywhere.
 *
 * What is left is identity and the window buttons. That is deliberately little:
 * on Windows and Linux this strip is the frame, and the frame is not a place to
 * put features.
 */
export function WindowTitleBar() {
  const { t } = useI18n();

  // On macOS, we don't need the custom title bar (uses native hiddenInset)
  if (isMac) {
    return null;
  }

  return (
    <div className="relative z-50 flex h-8 shrink-0 items-center justify-between border-b bg-background drag-region select-none">
      {/* Left: app identity. Not a button any more — clicking the logo to open
          Settings was an undiscoverable second entry point to something the
          sidebar footer now names outright, and a draggable title bar should
          not have a click target spanning its whole left side. */}
      <div className="flex h-8 items-center gap-1.5 px-2">
        <img src={logoImage} alt="AI Client" className="h-5 w-5" />
        <span className="text-xs font-medium text-muted-foreground">{t('AI Client')}</span>
      </div>

      {/* Right: window controls only. */}
      <div className="flex items-center no-drag">
        <WindowControls />
      </div>
    </div>
  );
}
