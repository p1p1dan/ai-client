import type { PluginView } from '@shared/plugins/view';
import type { RunStatus } from '@/components/ui/status-icon';

type Translate = (text: string, vars?: Record<string, string | number>) => string;

/** What the card's status line shows: the plugin's own line while it runs, ours otherwise. */
export function pluginStatusLine(
  plugin: PluginView,
  t: Translate
): { status: RunStatus; text: string } {
  if (plugin.state === 'failed') {
    return {
      status: 'failed',
      text:
        plugin.restartCount > 0
          ? t('Failed · retried {{count}} times', { count: plugin.restartCount })
          : t('Failed'),
    };
  }
  if (plugin.state === 'starting') return { status: 'running', text: t('Starting…') };
  if (plugin.state === 'stopped') {
    return plugin.enabled && plugin.restartCount > 0
      ? { status: 'waiting', text: t('Restarting…') }
      : { status: 'idle', text: plugin.enabled ? t('Stopped') : t('Off') };
  }
  const own = plugin.status;
  const status: RunStatus =
    own?.state === 'error'
      ? 'failed'
      : own?.state === 'warning'
        ? 'waiting'
        : own?.state === 'idle'
          ? 'idle'
          : 'success';
  return { status, text: own?.text || t('Running') };
}
