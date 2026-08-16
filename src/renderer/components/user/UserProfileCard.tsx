import {
  AUTH_GATE_SNAPSHOT_QUERY_KEY,
  AUTH_OPEN_ONBOARDING_EVENT,
  type UserProfilePresentation,
} from '@shared/authGate';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toastManager } from '@/components/ui/toast';
import { useUsageStats } from '@/hooks/useUsageStats';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const usageNumberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

function formatUsageValue(value: number): string {
  return usageNumberFormatter.format(value);
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

function UsageMetric({
  label,
  value,
  loading,
}: {
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="mt-1 h-4 w-16" />
      ) : (
        <div className="mt-1 text-sm font-medium">{value}</div>
      )}
    </div>
  );
}

interface UserProfileCardProps {
  /** D47 S5: three-state presentation (`deriveUserProfilePresentation`) replaces the raw email prop. */
  presentation: UserProfilePresentation;
  onRequestClose?: () => void;
}

export function UserProfileCard({ presentation, onRequestClose }: UserProfileCardProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const isAuthenticated = presentation.tone === 'signed-in';
  const email = isAuthenticated ? presentation.email : null;
  const usage = useUsageStats({ enabled: isAuthenticated });
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const pendingCredentials =
    !!usage.data && 'error' in usage.data && usage.data.error === 'Credentials not available';
  const metricsLoading = usage.isLoading || pendingCredentials;

  const initial = useMemo(() => {
    const ch = email?.trim()?.[0] ?? '?';
    return ch.toUpperCase();
  }, [email]);

  const todayCallsText = useMemo(() => {
    if (metricsLoading) {
      return '';
    }
    if (!usage.data || 'error' in usage.data) {
      return '暂不可用';
    }
    return formatUsageValue(usage.data.todayCount);
  }, [metricsLoading, usage.data]);

  const todayCostText = useMemo(() => {
    if (metricsLoading) {
      return '';
    }
    if (!usage.data || 'error' in usage.data) {
      return '暂不可用';
    }
    return formatCostUsd(usage.data.todayCostUsd);
  }, [metricsLoading, usage.data]);

  const monthCallsText = useMemo(() => {
    if (metricsLoading) {
      return '';
    }
    if (!usage.data || 'error' in usage.data) {
      return '暂不可用';
    }
    return formatUsageValue(usage.data.monthCount);
  }, [metricsLoading, usage.data]);

  const monthCostText = useMemo(() => {
    if (metricsLoading) {
      return '';
    }
    if (!usage.data || 'error' in usage.data) {
      return '暂不可用';
    }
    return formatCostUsd(usage.data.monthCostUsd);
  }, [metricsLoading, usage.data]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      const ok = await window.electronAPI.onboarding.logout();
      if (!ok) {
        toastManager.add({
          type: 'error',
          title: t('Logout failed'),
          description: t('Failed to clear onboarding state.'),
        });
        return;
      }

      queryClient.invalidateQueries({ queryKey: ['usageStats'] });
      queryClient.invalidateQueries({ queryKey: AUTH_GATE_SNAPSHOT_QUERY_KEY });
      onRequestClose?.();
      window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT));
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('Logout failed'),
        description: error instanceof Error ? error.message : t('Unknown error'),
      });
    } finally {
      setLoggingOut(false);
    }
  }, [onRequestClose, queryClient, t]);

  const handleOpenOnboarding = useCallback(() => {
    onRequestClose?.();
    window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT));
  }, [onRequestClose]);

  // D47 S5: `attention` (credentials_invalid/locked) and `signed-out`
  // (signed_out/unknown) both render a compact call-to-action instead of the
  // usage/logout panel below — there is nothing to log out of yet, only
  // somewhere to send the user (back through onboarding, re-verifying via
  // `AUTH_OPEN_ONBOARDING_EVENT`).
  if (!isAuthenticated) {
    const isAttention = presentation.tone === 'attention';
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Avatar className="size-9">
            <AvatarFallback
              className={cn(
                'text-foreground',
                isAttention ? 'bg-destructive/12 text-destructive' : 'bg-muted'
              )}
            >
              {isAttention ? <AlertTriangle className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                'text-sm font-medium',
                isAttention ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {isAttention ? t('Login expired') : t('Not signed in')}
            </div>
            {presentation.email && (
              <div className="truncate text-xs text-muted-foreground">{presentation.email}</div>
            )}
          </div>
        </div>
        <Button
          variant={isAttention ? 'destructive' : 'default'}
          className="w-full"
          onClick={handleOpenOnboarding}
        >
          <LogIn className="mr-2 h-4 w-4" />
          {isAttention ? t('Sign in again') : t('Sign in')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar className="size-9">
          <AvatarFallback className="bg-muted text-foreground">{initial}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-medium', !email && 'text-muted-foreground')}>
            <span className="block truncate">{email ?? t('Not signed in')}</span>
          </div>
        </div>

        <button
          type="button"
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-md',
            'text-muted-foreground hover:text-foreground hover:bg-muted/80',
            'transition-colors duration-150 disabled:opacity-50 disabled:hover:bg-transparent'
          )}
          onClick={() => {
            if (!email || usage.isFetching) {
              return;
            }
            void usage.refetch();
          }}
          disabled={!email || usage.isFetching}
          aria-label={t('Refresh usage')}
          title={t('Refresh usage')}
        >
          <RefreshCw className={cn('h-4 w-4', usage.isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <UsageMetric label={t('Today calls')} value={todayCallsText} loading={metricsLoading} />
        <UsageMetric label={t('Today cost')} value={todayCostText} loading={metricsLoading} />
        <UsageMetric
          label={t('This month calls')}
          value={monthCallsText}
          loading={metricsLoading}
        />
        <UsageMetric label={t('This month cost')} value={monthCostText} loading={metricsLoading} />
      </div>

      <Separator />

      <Button
        variant="destructive"
        className="w-full"
        onClick={() => setLogoutConfirmOpen(true)}
        disabled={!email || loggingOut}
      >
        <LogOut className="mr-2 h-4 w-4" />
        {t('Logout')}
      </Button>

      <Dialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <DialogPopup className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('Confirm logout')}</DialogTitle>
            <DialogDescription>
              {t(
                'This will terminate all active agent and terminal sessions. You will need to register again to continue using AI features.'
              )}
            </DialogDescription>
            {/* D47 S6 §2 (A-m9) — known limitation: flag-on logout stops
                touching ~/.claude at all (U1 decision), so a CLI logged in
                outside this app keeps working after this dialog's logout. */}
            <p className="text-xs text-muted-foreground">
              {t('This does not affect CLI logins in your system terminal.')}
            </p>
          </DialogHeader>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              onClick={() => setLogoutConfirmOpen(false)}
              disabled={loggingOut}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setLogoutConfirmOpen(false);
                await handleLogout();
              }}
              disabled={loggingOut}
            >
              {t('Logout')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
