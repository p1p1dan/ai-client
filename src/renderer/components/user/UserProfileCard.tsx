import { useQueryClient } from '@tanstack/react-query';
import { LogOut, RefreshCw } from 'lucide-react';
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

const ONBOARDING_OPEN_EVENT = 'ensoai:onboarding:open';

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
      {loading ? <Skeleton className="mt-1 h-4 w-16" /> : <div className="mt-1 text-sm font-medium">{value}</div>}
    </div>
  );
}

interface UserProfileCardProps {
  email: string | null;
  onRequestClose?: () => void;
}

export function UserProfileCard({ email, onRequestClose }: UserProfileCardProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const usage = useUsageStats({ enabled: Boolean(email) });
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
      queryClient.invalidateQueries({ queryKey: ['onboardingState'] });
      onRequestClose?.();
      window.dispatchEvent(new CustomEvent(ONBOARDING_OPEN_EVENT));
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
        <UsageMetric label={t('This month calls')} value={monthCallsText} loading={metricsLoading} />
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
