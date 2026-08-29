import type {
  PiModelManagementSettings as PiModelManagementSnapshot,
  PiModelSyncResult,
} from '@shared/piModelConfig';
import { CheckCircle2, ExternalLink, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';

function formatTime(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function sourceLabel(source: PiModelManagementSnapshot['state']['source']): string {
  switch (source) {
    case 'remote':
      return 'Remote';
    case 'stale-cache':
      return 'Cached';
    case 'seed':
      return 'Default';
    case 'local':
      return 'Local setup';
  }
}

export function PiModelManagementSettings() {
  const [snapshot, setSnapshot] = useState<PiModelManagementSnapshot | null>(null);
  const [endpointUrl, setEndpointUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    const next = await window.electronAPI.piModels.getStatus();
    setSnapshot(next);
    setEndpointUrl(next.endpointUrl);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const result: PiModelSyncResult = await window.electronAPI.piModels.sync({ endpointUrl });
      setMessage({
        text: result.ok
          ? `已更新 ${result.providerCount} 个渠道、${result.modelCount} 个模型。`
          : result.error || '同步失败',
        error: !result.ok,
      });
      await load();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setSyncing(false);
    }
  };

  const state = snapshot?.state;
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-title font-semibold tracking-[-0.01em]">Pi 模型管理</h3>
        <p className="text-ui text-muted-foreground">
          登录模式从管理端同步模型元数据到隔离目录；API key 仍由账号登录注入。
        </p>
      </div>

      {!snapshot?.managed && (
        <div className="flex gap-3 rounded-md border border-info/30 bg-info/10 p-3 text-ui text-info">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
          当前是 “Use my own setup”，Pi 会直接读取你自己的 ~/.pi/agent 配置。
        </div>
      )}

      <div className="rounded-md border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-ui font-semibold">管理端</span>
          </div>
          {state && (
            <Badge variant={state.source === 'remote' ? 'success' : 'warning'}>
              {sourceLabel(state.source)}
            </Badge>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="pi-model-management-url" className="text-meta text-muted-foreground">
            配置地址
          </label>
          <div className="flex gap-2">
            <Input
              id="pi-model-management-url"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="http://127.0.0.1:3210/api/v1/models-config"
              disabled={!snapshot?.managed || syncing}
            />
            <Button
              variant="outline"
              onClick={() => window.electronAPI.piModels.openAdmin(endpointUrl)}
              disabled={!endpointUrl.trim()}
            >
              <ExternalLink className="h-4 w-4" />
              打开
            </Button>
            <Button onClick={sync} disabled={!snapshot?.managed || !endpointUrl.trim() || syncing}>
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '同步中' : '立即同步'}
            </Button>
          </div>
        </div>

        {state && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 text-meta sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">渠道</dt>
              <dd className="tabular-nums font-semibold">{state.providerCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">模型</dt>
              <dd className="tabular-nums font-semibold">{state.modelCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">上次成功</dt>
              <dd className="tabular-nums">{formatTime(state.syncedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">上次尝试</dt>
              <dd className="tabular-nums">{formatTime(state.lastAttemptAt)}</dd>
            </div>
          </dl>
        )}

        {state?.agentDir && (
          <p className="break-all text-meta text-muted-foreground">
            隔离目录：<Ident>{state.agentDir}</Ident>
          </p>
        )}
        {(message || state?.error) && (
          <div
            className={`flex gap-2 rounded-sm border p-3 text-ui ${
              message?.error || (!message && state?.error)
                ? 'border-destructive/30 bg-destructive/8 text-destructive'
                : 'border-success/30 bg-success/8 text-success'
            }`}
          >
            {message?.error || (!message && state?.error) ? (
              <TriangleAlert className="h-4 w-4 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            )}
            {message?.text || state?.error}
          </div>
        )}
      </div>

      <div className="rounded-md border p-4 text-meta text-muted-foreground space-y-1">
        <p>本地管理端：运行 pnpm model-admin，然后访问 http://127.0.0.1:3210。</p>
        <p>部署到服务器时只需替换上面的 URL；管理接口返回模型元数据，不返回任何 key。</p>
      </div>
    </div>
  );
}
