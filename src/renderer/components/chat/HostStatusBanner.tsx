import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type HostStatus, isNode24ResolutionFailure } from './hostStatus';

/**
 * Compact diagnostics ribbon (T-09): shown only while the Host is not ready.
 *
 * Covers: host-not-ready placeholder, Node 24 missing actionable guidance
 * (`AICLIENT_NODE24_PATH`), generic Host error with the fatal message, and a
 * Retry that re-runs `ensureHost`. A small diagnostics line surfaces the
 * Host-reported Node version/path, Cometix version, and settings state when
 * available (so users can see e.g. missing auth token).
 */

interface HostStatusBannerProps {
  status: HostStatus;
  onRetry: () => void;
}

const STATE_TITLE: Record<HostStatus['state'], string> = {
  stopped: 'Agent Host 已停止',
  starting: 'Agent Host 正在启动…',
  ready: '',
  error: 'Agent Host 出错',
};

export function HostStatusBanner({ status, onRetry }: HostStatusBannerProps) {
  if (status.state === 'ready') return null;

  const isError = status.state === 'error';
  const isNodeMissing = isError && isNode24ResolutionFailure(status);

  const title = isNodeMissing
    ? 'Agent Host 未就绪：未找到 Node 24 运行时'
    : isError
      ? (status.lastFatalError ?? STATE_TITLE.error)
      : STATE_TITLE[status.state];

  const guidance = isNodeMissing
    ? '设置环境变量 AICLIENT_NODE24_PATH 指向 Node 24 可执行文件，或安装 Node 24 后点击 Retry'
    : isError
      ? '点击 Retry 重新启动 Agent Host'
      : status.state === 'stopped'
        ? '点击 Retry 拉起 Agent Host'
        : '';

  const diagnostics = formatDiagnostics(status);
  const Icon = isError ? AlertTriangle : RefreshCw;

  return (
    <div
      className={`shrink-0 border-b px-3 py-2 text-meta ${
        isError
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-status-running/30 bg-status-running/10 text-status-running'
      }`}
      role="status"
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <p className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </p>
        {status.state !== 'starting' && (
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-ui" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        )}
      </div>
      {guidance && <p className="mt-1 break-words opacity-90">{guidance}</p>}
      {diagnostics && (
        <p className="mt-1 break-words font-mono text-code opacity-75">{diagnostics}</p>
      )}
    </div>
  );
}

function formatDiagnostics(status: HostStatus): string {
  const parts: string[] = [];
  if (status.nodeVersion) parts.push(`Node ${status.nodeVersion}`);
  if (status.nodeExecPath) parts.push(`path: ${status.nodeExecPath}`);
  if (status.cometixVersion) parts.push(`Cometix ${status.cometixVersion}`);
  if (status.driver) parts.push(`driver: ${status.driver}`);
  if (status.pid) parts.push(`pid: ${status.pid}`);
  const settings = status.settings;
  if (settings) {
    parts.push(
      `auth=${settings.hasAuthToken ? 'ok' : 'missing'}`,
      `baseUrl=${settings.hasBaseUrl ? 'ok' : 'missing'}`,
      settings.baseHost ? `host=${settings.baseHost}` : '',
      settings.model ? `model=${settings.model}` : ''
    );
  }
  return parts.filter(Boolean).join(' · ');
}
