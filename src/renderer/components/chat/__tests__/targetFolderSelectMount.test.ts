// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderMenuModel } from '../composerTarget';

/**
 * Decision 174 (GitHub issue #6, second wave; user ruling 2026-10-10, ruling
 * 6): the work bar's repository menu — 「不选仓库（临时对话）」 as a row, the
 * add actions as rows of an 「添加仓库」 group (keyboard-navigable and
 * searchable, where they used to be footer buttons), 「还没有仓库」 when there
 * is none, group names at 14px, and 「未选仓库」 on the trigger.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));

import { TargetFolderSelect } from '../TargetFolderSelect';

let root: Root | undefined;
let container: HTMLDivElement;

const MENU: FolderMenuModel = {
  recents: [{ workspaceId: 'ws-alpha', projectId: 'p-alpha', label: 'alpha', current: true }],
  local: [
    { workspaceId: 'ws-alpha', projectId: 'p-alpha', label: 'alpha', current: true },
    { workspaceId: 'ws-beta', projectId: 'p-beta', label: 'beta', current: false },
  ],
  remote: [],
};
const EMPTY: FolderMenuModel = { recents: [], local: [], remote: [] };

const handlers = {
  onSelect: vi.fn(),
  onSelectUnbound: vi.fn(),
  onAddRepository: vi.fn(),
  onCreateTempTarget: vi.fn(async () => undefined),
};

async function mount(props: {
  folderMenu: FolderMenuModel;
  currentLabel: string | null;
  activeWorkspaceId: string | null;
  unboundSelected?: boolean;
}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(TargetFolderSelect, {
        ...props,
        workspacePath: props.currentLabel ? '/repo/alpha' : null,
        disabled: false,
        ...handlers,
      })
    )
  );
}

const trigger = () => container.querySelector('button') as HTMLButtonElement;

async function openMenu() {
  await act(async () => trigger().click());
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (text: string) => {
  const found = options().find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`option ${text} not rendered`);
  return found;
};
const groupLabels = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="combobox-group-label"]'),
];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const fn of Object.values(handlers)) fn.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the repository menu on the home page', () => {
  it('lists the repositories, 「不选仓库（临时对话）」, and the 「添加仓库」 rows', async () => {
    await mount({ folderMenu: MENU, currentLabel: 'alpha', activeWorkspaceId: 'ws-alpha' });
    expect(trigger().textContent).toContain('alpha');
    await openMenu();
    const texts = options().map((node) => node.textContent?.trim());
    expect(texts).toEqual(
      expect.arrayContaining([
        'alpha',
        'beta',
        'No repository (temporary chat)',
        'Use Existing…',
        'Clone…',
        'Add Remote…',
      ])
    );
    // The add actions are rows of the list now, after 「不选仓库」.
    expect(texts.indexOf('No repository (temporary chat)')).toBeLessThan(
      texts.indexOf('Use Existing…')
    );
    const labels = groupLabels().map((node) => node.textContent);
    expect(labels).toEqual(['Recents', 'On This PC', 'Add Repository']);
    for (const label of groupLabels()) {
      expect(label.className).toContain('text-meta');
      expect(label.className).toContain('font-normal');
      expect(label.className).not.toContain('text-xs');
    }
  });

  it('「不选仓库」 picks no repository; an add row opens the dialog on its tab', async () => {
    await mount({ folderMenu: MENU, currentLabel: 'alpha', activeWorkspaceId: 'ws-alpha' });
    await openMenu();
    await act(async () => option('No repository (temporary chat)').click());
    expect(handlers.onSelectUnbound).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();

    await openMenu();
    await act(async () => option('Clone…').click());
    expect(handlers.onAddRepository).toHaveBeenCalledWith('remote');
  });

  it('a repository row picks that repository', async () => {
    await mount({ folderMenu: MENU, currentLabel: 'alpha', activeWorkspaceId: 'ws-alpha' });
    await openMenu();
    await act(async () => option('beta').click());
    expect(handlers.onSelect).toHaveBeenCalledWith('ws-beta');
  });

  it('with no repository: 「未选仓库」 on the trigger, 「还没有仓库」, and still a way to add one', async () => {
    await mount({
      folderMenu: EMPTY,
      currentLabel: null,
      activeWorkspaceId: null,
      unboundSelected: true,
    });
    expect(trigger().textContent).toContain('No repository chosen');
    expect(trigger().title).toBe('Choose or add a repository');
    await openMenu();
    expect(document.body.textContent).toContain('No repositories yet');
    expect(options().map((node) => node.textContent?.trim())).toEqual([
      'No repository (temporary chat)',
      'Use Existing…',
      'Clone…',
      'Add Remote…',
      // The temporary-workspace row, with its muted hint.
      'New FolderNew temporary workspace',
    ]);
  });
});
