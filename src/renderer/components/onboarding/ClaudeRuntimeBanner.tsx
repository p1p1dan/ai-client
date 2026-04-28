import type { ClaudeRuntimeStatus } from '@shared/types';
import { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
import { Loader2, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'aiclient-claude-runtime-banner-dismissed-version';

interface ClaudeRuntimeBannerProps {
  status: ClaudeRuntimeStatus;
  onStatusChange: (next: ClaudeRuntimeStatus) => void;
}

/**
 * Yellow header that appears when the locally-installed Claude Code is on a
 * Bun build (>= 2.1.113). On TEC OCular Agent encrypted machines those builds
 * fall outside the whitelist and break file reads, so we offer a one-click
 * downgrade to the last Node-compatible release. Users can dismiss the
 * banner per-version if they accept the risk.
 */
export function ClaudeRuntimeBanner({ status, onStatusChange }: ClaudeRuntimeBannerProps) {
  const [downgrading, setDowngrading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!downgrading) return;
    return window.electronAPI.claudeRuntime.onDowngradeProgress(({ message }) => {
      setProgress(message);
    });
  }, [downgrading]);

  const handleDowngrade = useCallback(async () => {
    setDowngrading(true);
    setProgress('准备开始...');
    setError(null);
    try {
      const result = await window.electronAPI.claudeRuntime.downgrade();
      if (result.success && result.status) {
        onStatusChange(result.status);
      } else {
        setError(result.error ?? '降级失败，请稍后重试');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDowngrading(false);
      setProgress(null);
    }
  }, [onStatusChange]);

  const handleDismiss = useCallback(() => {
    if (!status.cliVersion) return;
    try {
      localStorage.setItem(STORAGE_KEY, status.cliVersion);
    } catch {
      // ignore
    }
    setDismissed(status.cliVersion);
  }, [status.cliVersion]);

  if (status.kind !== 'bun-incompatible') return null;
  if (status.cliVersion && dismissed === status.cliVersion && !downgrading) return null;

  return (
    <div className="flex items-center gap-3 border-b border-yellow-300/60 bg-yellow-50 px-4 py-2 text-xs text-yellow-900 dark:border-yellow-500/40 dark:bg-yellow-900/30 dark:text-yellow-100">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <div className="flex-1">
        {downgrading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{progress ?? '正在降级 Claude Code...'}</span>
          </div>
        ) : (
          <>
            检测到 Claude Code 为 Bun 版本（v{status.cliVersion ?? '?'}），可能与公司加密环境（TEC OCular
            Agent）不兼容。建议降级到 Node 版（v{LAST_NODE_CLAUDE_VERSION}）以恢复会话历史等功能。
            {error ? <span className="ml-2 text-destructive">{error}</span> : null}
          </>
        )}
      </div>
      {!downgrading && (
        <>
          <Button size="sm" variant="outline" onClick={handleDowngrade} disabled={downgrading}>
            一键降级到 v{LAST_NODE_CLAUDE_VERSION}
          </Button>
          <button
            type="button"
            aria-label="忽略此次提示"
            className="rounded p-1 hover:bg-yellow-200/40 dark:hover:bg-yellow-700/40"
            onClick={handleDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
