import type { PluginView } from '@shared/plugins/view';
import { describe, expect, it } from 'vitest';
import { pluginStatusLine } from '../pluginStatusLine';

const t = ((text: string, vars?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars?.[key] ?? ''))) as never;

const base: PluginView = {
  id: 'pilab.remote-access',
  name: '手机远程',
  version: '0.1.0',
  permissions: ['chat.read'],
  netHosts: [],
  enabled: true,
  state: 'running',
  restartCount: 0,
  services: [],
  settings: [],
};

describe('Plugins page status line', () => {
  it.each<[string, Partial<PluginView>, string, string]>([
    ['off', { enabled: false, state: 'stopped' }, 'idle', 'Off'],
    ['starting', { state: 'starting' }, 'running', 'Starting…'],
    ['running, own line', { status: { state: 'ok', text: '已连上中转' } }, 'success', '已连上中转'],
    [
      'running, plugin warns',
      { status: { state: 'warning', text: '中转断开，重连中' } },
      'waiting',
      '中转断开，重连中',
    ],
    [
      'running, plugin errors',
      { status: { state: 'error', text: '口令错误' } },
      'failed',
      '口令错误',
    ],
    ['running, nothing said', {}, 'success', 'Running'],
    ['waiting to restart', { state: 'stopped', restartCount: 2 }, 'waiting', 'Restarting…'],
    [
      'failed after retries',
      { state: 'failed', restartCount: 5 },
      'failed',
      'Failed · retried 5 times',
    ],
    ['failed at once', { state: 'failed' }, 'failed', 'Failed'],
  ])('[PLG-PAGE] %s', (_label, patch, status, text) => {
    expect(pluginStatusLine({ ...base, ...patch }, t)).toEqual({ status, text });
  });
});
