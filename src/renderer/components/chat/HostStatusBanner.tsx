import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatusIcon } from '@/components/ui/status-icon';
import { useI18n } from '@/i18n';
import { describeHostStatus, type HostStatus } from './hostStatus';

/**
 * Compact diagnostics ribbon (T-09): shown only while the Host is not ready.
 *
 * Covers: host-not-ready placeholder, generic Host error with the fatal
 * message, and a Retry that re-runs `ensureHost`. A small diagnostics line
 * surfaces the Host-reported pool counters when available.
 *
 * Which states speak at all is `describeHostStatus` (hostStatus.ts) — a pure
 * function, because the node-env vitest config cannot render this `.tsx`, and
 * the rule it encodes ("never claim a stopped service that answers the very
 * next message") is exactly the kind that needs a real test.
 *
 * Design system v2 §7.7: drawn as the one notice (`Alert`), inset from the
 * column edges instead of a hand-tinted full-bleed strip. An error is the
 * error tone; a host coming back is neutral with the shared running icon
 * (§6: running is gray, never blue).
 */

interface HostStatusBannerProps {
  status: HostStatus;
  onRetry: () => void;
}

export function HostStatusBanner({ status, onRetry }: HostStatusBannerProps) {
  const { t } = useI18n();
  const model = describeHostStatus(status);
  if (!model) return null;

  const isError = model.tone === 'error';
  const diagnostics = formatDiagnostics(status);

  return (
    <div className="shrink-0 px-3 pt-2">
      <Alert variant={isError ? 'error' : 'default'} role="status" className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {isError ? (
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <StatusIcon status="running" />
          )}
          {/* `title` is a dictionary key unless the Host supplied its own fatal
            error text, in which case `t()` returns it unchanged (a key with no
            entry IS its own English). */}
          <p className="min-w-0 flex-1 truncate font-medium text-foreground" title={t(model.title)}>
            {t(model.title)}
          </p>
          {model.showRetry && (
            <Button size="xs" variant="ghost" className="-my-1" onClick={onRetry}>
              <RefreshCw />
              {t('Retry')}
            </Button>
          )}
        </div>
        {model.guidance && (
          <p className="break-words pl-5.5 text-muted-foreground">{t(model.guidance)}</p>
        )}
        {diagnostics && (
          <p className="break-words pl-5.5 font-mono text-code text-muted-foreground">
            {diagnostics}
          </p>
        )}
      </Alert>
    </div>
  );
}

function formatDiagnostics(status: HostStatus): string {
  const parts: string[] = [];
  if (status.capacity !== undefined) parts.push(`capacity=${status.capacity}`);
  if (status.slots !== undefined) parts.push(`slots=${status.slots}`);
  if (status.active !== undefined) parts.push(`active=${status.active}`);
  if (status.restarting) parts.push(`restarting=${status.restarting}`);
  if (status.errors) parts.push(`errors=${status.errors}`);
  return parts.join(' · ');
}
