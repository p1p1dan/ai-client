import { getPathBasename } from '@shared/utils/path';
import { useEffect } from 'react';
import type { Repository } from '../constants';
import { ensureRepositoryId, pathsEqual } from '../storage';

export function useOpenPathListener(
  enabled: boolean,
  repositories: Repository[],
  saveRepositories: (repos: Repository[]) => void,
  setSelectedRepo: (repo: string) => void
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    function handle(rawPath: string) {
      const path = rawPath.replace(/[\\/]+$/, '').replace(/^["']|["']$/g, '');
      const existingRepo = repositories.find((r) => pathsEqual(r.path, path));
      if (existingRepo) {
        setSelectedRepo(existingRepo.path);
      } else {
        const name = getPathBasename(path);
        const newRepo: Repository = ensureRepositoryId({
          name,
          path,
          kind: 'local',
        });
        const updated = [...repositories, newRepo];
        saveRepositories(updated);
        setSelectedRepo(path);
      }
    }

    const cleanup = window.electronAPI.app.onOpenPath(handle);

    // Pull any open-path that arrived before this listener was registered
    // (main process pushes are dropped if fired before did-finish-load's
    // listener exists, since Electron IPC has no replay).
    let cancelled = false;
    void window.electronAPI.app.takePendingOpenPath().then((p) => {
      if (!cancelled && p) handle(p);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [enabled, repositories, saveRepositories, setSelectedRepo]);
}
