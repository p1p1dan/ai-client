import { describe, expect, it } from 'vitest';
import config from '../../../electron.vite.config';

type PluginLike = {
  name?: string;
};

function getPluginNames(plugins: unknown[] | undefined): string[] {
  return (plugins ?? [])
    .map((plugin) => (plugin as PluginLike | null)?.name)
    .filter((name): name is string => Boolean(name));
}

describe('electron.vite packaging config', () => {
  it('does not externalize all package dependencies for main or preload builds', () => {
    expect(getPluginNames(config.main?.plugins)).not.toContain('vite:externalize-deps');
    expect(getPluginNames(config.preload?.plugins)).not.toContain('vite:externalize-deps');
  });
});
