import type { ClaudeRuntimeStatus } from '@shared/types';
import { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Title-bar warning indicator for Bun-built Claude Code (>= 2.1.113). On TEC
 * OCular Agent encrypted machines those builds fall outside the whitelist and
 * break file reads, so we offer a one-click downgrade to the last
 * Node-compatible release.
 *
 * Replaces the old full-width yellow banner: the icon stays visible for as
 * long as the Bun runtime is detected (so every launch is reminded), and the
 * explanation + downgrade action live in a popover. There is deliberately no
 * "dismiss forever" persistence anymore.
 *
 * Reads the shared ['claudeRuntimeStatus'] query (same key as useGateStatus)
 * so no props need to be threaded through the title bar.
 */
export function ClaudeRuntimeIndicator() {
  const queryClient = useQueryClient();
  const runtime = useQuery({
    queryKey: ['claudeRuntimeStatus'],
    queryFn: async () => window.electronAPI.claudeRuntime.check(false),
    staleTime: 1000 * 30,
    retry: 1,
  });
  const status: ClaudeRuntimeStatus | undefined = runtime.data;

  const [open, setOpen] = useState(false);
  const [downgrading, setDowngrading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        // Flipping the query data to node-compatible unmounts the indicator.
        queryClient.setQueryData(['claudeRuntimeStatus'], result.status);
      } else {
        setError(result.error ?? '降级失败，请稍后重试');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDowngrading(false);
      setProgress(null);
    }
  }, [queryClient]);

  if (status?.kind !== 'bun-incompatible') return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-lg no-drag',
          'text-warning hover:bg-muted/80',
          'transition-colors duration-150'
        )}
        aria-label="Claude Code 运行时提示"
        title="Claude Code 为 Bun 版本，点击查看详情"
      >
        {downgrading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" sideOffset={8} className="w-[320px]">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">Claude Code 为 Bun 版本</span>
              <span className="text-xs text-muted-foreground">
                当前版本 v{status.cliVersion ?? '?'}
                ，可能与公司加密环境（TEC OCular Agent）不兼容。建议降级到 Node 版（v
                {LAST_NODE_CLAUDE_VERSION}）以恢复会话历史等功能。
              </span>
            </div>
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
          {downgrading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {progress ?? '正在降级 Claude Code...'}
              </span>
            </div>
          ) : (
            <Button size="sm" onClick={handleDowngrade}>
              一键降级到 v{LAST_NODE_CLAUDE_VERSION}
            </Button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
