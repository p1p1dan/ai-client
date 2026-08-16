import { AUTH_GATE_SNAPSHOT_QUERY_KEY, deriveUserProfilePresentation } from '@shared/authGate';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Settings,
  Terminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import logoImage from '@/assets/logo.png';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  TitleBarMenuPopup,
} from '@/components/ui/menu';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { UserProfileCard } from '@/components/user/UserProfileCard';
import { useUsageStats } from '@/hooks/useUsageStats';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { WindowControls } from './WindowControls';

// 平台检查在模块级别进行，避免在组件内部违反 Hooks 规则
const isMac = typeof window !== 'undefined' && window.electronAPI?.env?.platform === 'darwin';

interface WindowTitleBarProps {
  onOpenSettings?: () => void;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Custom title bar for frameless windows (Windows/Linux)
 * Modern minimal design with settings button and more menu
 */
export function WindowTitleBar({ onOpenSettings }: WindowTitleBarProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  // D47 S5: stop reading the retired `onboardingState` query — the gate
  // snapshot / `auth.stateChanged` push is now the single source of truth for
  // whether a user identity exists at all (three-state chip below). Same
  // query key Root.tsx uses: when nested under it, this dedupes onto the
  // same cache entry instead of firing a second `getGateSnapshot()` IPC
  // round trip; when mounted standalone (the `skipAuthGate` escape hatch
  // never mounts Root's gate query at all), it fetches on its own.
  const gateQuery = useQuery({
    queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY,
    queryFn: () => window.electronAPI.auth.getGateSnapshot(),
    staleTime: Infinity,
  });

  useEffect(() => {
    return window.electronAPI.auth.onStateChanged((state) => {
      queryClient.setQueryData(AUTH_GATE_SNAPSHOT_QUERY_KEY, (prev) =>
        prev ? { ...prev, state } : prev
      );
    });
  }, [queryClient]);

  const authState = gateQuery.data?.state ?? { status: 'unknown' as const };
  const presentation = deriveUserProfilePresentation(authState);
  const isAuthenticated = presentation.tone === 'signed-in';
  const email = presentation.email;
  const initial = (email?.trim()?.[0] ?? '?').toUpperCase();
  const usage = useUsageStats({ enabled: isAuthenticated });

  const todayCostUsd =
    usage.data && 'error' in usage.data ? null : (usage.data?.todayCostUsd ?? null);
  const todayCostText =
    usage.isLoading || todayCostUsd === null ? '--' : formatCostUsd(todayCostUsd);

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }
    setProfileOpen(false);
  }, [isAuthenticated]);

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

  const userPillClass = cn(
    'flex h-6 items-center gap-2 rounded-full border px-2',
    'bg-background/80 backdrop-blur-sm shadow-sm',
    'text-muted-foreground hover:text-foreground hover:bg-muted/80',
    'transition-colors duration-150'
  );

  return (
    <div className="relative z-50 flex h-8 shrink-0 items-center justify-between border-b bg-background drag-region select-none">
      {/* Left: App icon and name (clickable to open settings) */}
      <button
        type="button"
        onClick={onOpenSettings}
        className={cn(
          'flex h-8 items-center gap-1.5 px-2 no-drag',
          'transition-opacity duration-150 hover:opacity-80 active:opacity-60'
        )}
        title={`${t('Settings')} (Ctrl+,)`}
      >
        <img src={logoImage} alt="AI Client" className="h-5 w-5" />
        <span className="text-xs font-medium text-muted-foreground">AI Client</span>
      </button>

      {/* Right: Actions and window controls */}
      <div className="flex items-center no-drag">
        {/* User Profile — D47 S5: three-state chip driven by
            `deriveUserProfilePresentation`. Unlike the old `isRegistered &&`
            gate, this always renders — `invalid`/`signed_out` need a
            clickable affordance too (re-login / login), not just the
            authenticated usage summary. */}
        <Popover open={profileOpen} onOpenChange={setProfileOpen}>
          <PopoverTrigger
            className={cn(
              userPillClass,
              presentation.tone === 'attention' &&
                'border-destructive/40 text-destructive hover:text-destructive'
            )}
            aria-label={t('User profile')}
            title={isAuthenticated ? (email ?? t('User profile')) : t('User profile')}
          >
            {isAuthenticated ? (
              <>
                <Avatar className="size-5 bg-transparent">
                  <AvatarFallback className="bg-muted text-foreground text-xs">
                    {initial}
                  </AvatarFallback>
                </Avatar>
                <div className="h-3 w-px bg-border/70" />
                <span
                  className={cn(
                    'shrink-0 text-xs font-medium tabular-nums',
                    (usage.isLoading || todayCostUsd === null) && 'text-muted-foreground/70'
                  )}
                >
                  {todayCostText}
                </span>
              </>
            ) : presentation.tone === 'attention' ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="shrink-0 text-xs font-medium">{t('Login expired')}</span>
              </>
            ) : (
              <span className="shrink-0 text-xs font-medium">{t('Not signed in')}</span>
            )}
          </PopoverTrigger>
          <PopoverPopup align="end" sideOffset={8} className="w-[280px]">
            <UserProfileCard
              presentation={presentation}
              onRequestClose={() => setProfileOpen(false)}
            />
          </PopoverPopup>
        </Popover>

        {/* Settings Button */}
        <button
          type="button"
          onClick={onOpenSettings}
          className={iconButtonClass}
          aria-label={t('Settings')}
          title={`${t('Settings')} (Ctrl+,)`}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>

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
