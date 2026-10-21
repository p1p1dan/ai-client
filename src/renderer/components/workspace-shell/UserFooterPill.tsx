/**
 * D07: the account pill, moved down from `WindowTitleBar` into the left
 * column's footer. D08 moved it once more — out of `LeftNav` (which is now just
 * the `chat` surface's body) and into `LeftDock`, so it stays visible no matter
 * which of the five surfaces is showing.
 *
 * D47 S5 semantics are unchanged: a three-state chip driven by
 * `deriveUserProfilePresentation`, which always renders — `invalid` /
 * `signed_out` need a clickable affordance (re-login / login) just as much as
 * the signed-in account does, which is why this is not gated on "is
 * registered".
 *
 * Decision 183 (user ruling 2026-10-12, prototype v6 `.foot.proto`): the
 * prototype's 32px account row under a full-width hairline, so the footer no
 * longer reads like another chat row. Today's spend is no longer on it — the
 * user found a permanent cost figure stressful; the account card the pill
 * opens (`UserProfileCard`) still shows usage.
 *
 * F09 added the announcement bell to the right of the pill. It is NOT gated on
 * sign-in either, and for a stronger version of the same reason: the endpoint
 * is public precisely so that someone whose login has expired can still read
 * the message explaining it. The bell renders nothing when there is nothing to
 * announce, so an ordinary session sees the row exactly as it was.
 */
import { AUTH_GATE_SNAPSHOT_QUERY_KEY, deriveUserProfilePresentation } from '@shared/authGate';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronsUpDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AnnouncementBell } from '@/components/announcements/AnnouncementBell';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { UserProfileCard } from '@/components/user/UserProfileCard';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

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

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }
    setProfileOpen(false);
  }, [isAuthenticated]);

  return (
    // Decision 183 (prototype v6): a full-width hairline on top separates the
    // account zone from the list above it. Decision 188 (2026-10-13): 12px
    // from that hairline to the row, 10px from the row to the window bottom.
    <div className="flex shrink-0 items-center gap-1 border-t border-border-soft px-2 pt-3 pb-2.5">
      <Popover open={profileOpen} onOpenChange={setProfileOpen}>
        <PopoverTrigger
          className={cn(
            // Prototype `.me`: one 32px row in every state, so signing out or
            // an expired login does not change the footer's height.
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-xs px-2 text-left',
            'text-muted-foreground hover:bg-fill-ghost-hover',
            presentation.tone === 'attention' && 'text-destructive'
          )}
          aria-label={t('User profile')}
          title={isAuthenticated ? (email ?? t('User profile')) : t('User profile')}
        >
          {isAuthenticated ? (
            <>
              {/* Prototype `.av`: a 22px circle (`size-5.5`) on --selection
                  with a semibold initial. `text-small` (14px, line height 21px)
                  rather than the prototype's 12px: the initial can be CJK, and
                  CJK never goes below 14px (design system, CJK cascade). */}
              <Avatar className="size-5.5 shrink-0 bg-transparent">
                <AvatarFallback className="bg-fill-ghost-selected font-semibold text-foreground text-small">
                  {initial}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-ui text-foreground-soft">{email}</span>
            </>
          ) : presentation.tone === 'attention' ? (
            <>
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate text-small">{t('Login expired')}</span>
            </>
          ) : (
            <span className="min-w-0 truncate text-small">{t('Not signed in')}</span>
          )}
          <ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverPopup align="start" side="top" sideOffset={8} className="w-[280px]">
          <UserProfileCard
            presentation={presentation}
            onRequestClose={() => setProfileOpen(false)}
          />
        </PopoverPopup>
      </Popover>
      <AnnouncementBell />
    </div>
  );
}
