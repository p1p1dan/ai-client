import { ExternalLink, MoreHorizontal, RefreshCw, Terminal, X } from 'lucide-react';
import { useCallback } from 'react';
import logoImage from '@/assets/logo.png';
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  TitleBarMenuPopup,
} from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
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
 * The overflow menu stays. Unlike the other two it is app-level (reload,
 * devtools, exit) and this bar is the ONLY chrome the onboarding and welcome
 * shells render — there is no sidebar footer on those screens to move it to.
 *
 * `onOpenSettings` is gone with the Settings button; the sidebar footer owns
 * that entry point now.
 */
export function WindowTitleBar() {
  const { t } = useI18n();

  // 所有 hooks 必须在条件返回之前调用，遵循 React Hooks 规则
  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleOpenDevTools = useCallback(() => {
    window.electronAPI.window.openDevTools();
  }, []);

  const handleOpenExternal = useCallback((url: string) => {
    window.electronAPI.shell.openExternal(url);
  }, []);

  // On macOS, we don't need the custom title bar (uses native hiddenInset)
  if (isMac) {
    return null;
  }

  // 更多按钮样式
  const iconButtonClass = cn(
    'flex h-7 w-7 items-center justify-center rounded-lg',
    'text-muted-foreground hover:text-foreground hover:bg-muted/80',
    'transition-colors duration-150'
  );

  return (
    <div className="relative z-50 flex h-8 shrink-0 items-center justify-between border-b bg-background drag-region select-none">
      {/* Left: app identity. Not a button any more — clicking the logo to open
          Settings was an undiscoverable second entry point to something the
          sidebar footer now names outright, and a draggable title bar should
          not have a click target spanning its whole left side. */}
      <div className="flex h-8 items-center gap-1.5 px-2">
        <img src={logoImage} alt="AI Client" className="h-5 w-5" />
        <span className="text-xs font-medium text-muted-foreground">AI Client</span>
      </div>

      {/* Right: app menu and window controls */}
      <div className="flex items-center no-drag">
        {/* More Menu */}
        <Menu>
          <MenuTrigger
            render={
              <button type="button" className={iconButtonClass} aria-label={t('More')}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            }
          />
          <TitleBarMenuPopup align="end" sideOffset={6} className="min-w-[180px]">
            <MenuItem onClick={handleReload}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('Reload')}
              <MenuShortcut>Ctrl+R</MenuShortcut>
            </MenuItem>
            <MenuItem onClick={handleOpenDevTools}>
              <Terminal className="h-3.5 w-3.5" />
              {t('Developer Tools')}
              <MenuShortcut>F12</MenuShortcut>
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => handleOpenExternal('https://github.com/jyw-ai/jyw-ai-client')}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t('GitHub')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => window.electronAPI.window.close()}>
              <X className="h-3.5 w-3.5" />
              {t('Exit')}
              <MenuShortcut>Alt+F4</MenuShortcut>
            </MenuItem>
          </TitleBarMenuPopup>
        </Menu>

        {/* Separator */}
        <div className="h-4 w-px bg-border mx-1" />

        {/* Window controls */}
        <WindowControls />
      </div>
    </div>
  );
}
