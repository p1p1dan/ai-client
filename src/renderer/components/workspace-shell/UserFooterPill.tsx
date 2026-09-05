/**
 * D07: the account/usage pill, moved down from `WindowTitleBar` into the left
 * column's footer. D08 moved it once more — out of `LeftNav` (which is now just
 * the `chat` surface's body) and into `LeftDock`, so it stays visible no matter
 * which of the five surfaces is showing.
 *
 * D47 S5 semantics are unchanged: a three-state chip driven by
 * `deriveUserProfilePresentation`, which always renders — `invalid` /
 * `signed_out` need a clickable affordance (re-login / login) just as much as
 * the authenticated usage summary does, which is why this is not gated on
 * "is registered".
 */
import { AUTH_GATE_SNAPSHOT_QUERY_KEY, deriveUserProfilePresentation } from '@shared/authGate';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { UserProfileCard } from '@/components/user/UserProfileCard';
import { useUsageStats } from '@/hooks/useUsageStats';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function formatCostUsd(usd: number): string {
  // Sub-dollar spend is where the interesting resolution is; 4 decimals below
  // $1 and 2 above, carried over verbatim from `WindowTitleBar`.
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function UserFooterPill() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);

  // Same query key Root.tsx uses: nested under it this dedupes onto the same
  // cache entry instead of firing a second `getGateSnapshot()` IPC round trip.
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

  return (
    <div className="flex shrink-0 items-center border-t p-2">
      <Popover open={profileOpen} onOpenChange={setProfileOpen}>
        <PopoverTrigger
          className={cn(
            'flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5',
            'text-muted-foreground hover:bg-hover hover:text-foreground',
            presentation.tone === 'attention' && 'text-destructive hover:text-destructive'
          )}
          aria-label={t('User profile')}
          title={isAuthenticated ? (email ?? t('User profile')) : t('User profile')}
        >
          {isAuthenticated ? (
            <>
              {/* `text-meta`, not the `text-xs` this used in `WindowTitleBar`:
                  D25 §6.3 bans raw size utilities under `workspace-shell/`, and
                  the token is what the rest of this footer already uses. */}
              <Avatar className="size-4 shrink-0 bg-transparent">
                <AvatarFallback className="bg-muted text-foreground text-meta">
                  {initial}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-left text-meta">{email}</span>
              <span
                className={cn(
                  'shrink-0 text-meta tabular-nums',
                  (usage.isLoading || todayCostUsd === null) && 'text-muted-foreground/70'
                )}
              >
                {todayCostText}
              </span>
            </>
          ) : presentation.tone === 'attention' ? (
            <>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-meta">{t('Login expired')}</span>
            </>
          ) : (
            <span className="truncate text-meta">{t('Not signed in')}</span>
          )}
        </PopoverTrigger>
        <PopoverPopup align="start" side="top" sideOffset={8} className="w-[280px]">
          <UserProfileCard
            presentation={presentation}
            onRequestClose={() => setProfileOpen(false)}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
