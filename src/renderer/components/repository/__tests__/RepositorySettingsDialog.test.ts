// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRepositorySettings, saveRepositorySettings } from '@/App/storage';
import { RepositorySettingsDialog } from '../RepositorySettingsDialog';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;
const onOpenChange = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  onOpenChange.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('repository settings in the new shell', () => {
  it('saves the configured script for only the selected repository', async () => {
    saveRepositorySettings('/repo', { autoInitWorktree: true, initScript: 'old', hidden: false });
    saveRepositorySettings('/other', {
      autoInitWorktree: false,
      initScript: 'other',
      hidden: false,
    });
    await act(() =>
      root.render(
        createElement(RepositorySettingsDialog, {
          open: true,
          onOpenChange,
          repoPath: '/repo',
          repoName: 'repo',
        })
      )
    );
    expect(document.querySelector('#hidden-switch')).toBeNull();
    const textarea = document.querySelector<HTMLTextAreaElement>('#init-script')!;
    expect(textarea.value).toBe('old');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'pnpm install'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save'
    )!;
    await act(() => save.click());
    expect(getRepositorySettings('/repo')).toEqual({
      autoInitWorktree: true,
      initScript: 'pnpm install',
      hidden: false,
    });
    expect(getRepositorySettings('/other').initScript).toBe('other');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('exposes repository settings through the new shell and removes the old manager', () => {
    const nav = readFileSync(
      resolve('src/renderer/components/workspace-shell/LeftNav.tsx'),
      'utf8'
    );
    expect(nav).toContain('setRepoToConfigure(folderRepo)');
    expect(nav).toContain('repoPath={repoToConfigure.path}');
    expect(
      existsSync(resolve('src/renderer/components/repository/RepositoryManagerDialog.tsx'))
    ).toBe(false);
    const sidebar = readFileSync(resolve('src/renderer/components/layout/TreeSidebar.tsx'), 'utf8');
    expect(sidebar).not.toContain('RepositoryManagerDialog');
  });
});
