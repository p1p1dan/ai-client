import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * H/18 S1 + S2 — the sidebar's list and group menus and the repository menu.
 *
 * Static, for the same reason `unboundChatEntryStatic` is: what has to be
 * proven here is which element OWNS the right-click and which actions it
 * offers. Rendering LeftNav needs the whole store tree plus `window.electronAPI`
 * standing up, and even then a jsdom `contextmenu` on a Base UI trigger proves
 * only that the library works, which is not the thing that can regress.
 *
 * The nesting rule these menus depend on is Base UI's own: its context-menu
 * trigger calls `stopEvent` (preventDefault + stopPropagation) on the event, so
 * an inner trigger always wins over an outer one. That is why a row right-click
 * opens the row's menu and not the group's, and why a trigger with NO menu
 * behind it would be a trap — it would swallow the event and leave the user
 * with nothing.
 *
 * Decision 183 replaced the three regions with one list: the list carries
 * 「添加仓库」 (§2.10), the Temporary chats group 「新建临时对话」 (§2.9), and a
 * repository header its own menu, as before.
 */
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);

/** Source of the temporary-chat group, which is one self-contained helper. */
const temporaryGroup = (() => {
  const start = nav.indexOf('const renderTemporaryGroup');
  return nav.slice(start, nav.indexOf('\n  };', start));
})();

describe('S1 list and group context menus', () => {
  it('the temporary-chat group offers a new temporary chat, from its header 「＋」 too', () => {
    expect(temporaryGroup).toContain('<ContextMenuPrimitive.Root>');
    // Rendered AS the group's <section>, so the menu covers the header and the
    // gaps between rows rather than adding a wrapper element with its own box.
    expect(temporaryGroup).toMatch(
      /render=\{\s*<section className=\{SIDEBAR_GROUP_CLASS\} data-sidebar-group=\{UNBOUND_FOLDER_ID\} \/>\s*\}/
    );
    // The same header as a repository (decision 183 §1.3), no folder icon.
    expect(temporaryGroup).toContain('renderGroupHeader({');
    expect(temporaryGroup).not.toContain('FolderOpen');
    expect(temporaryGroup).toContain("{t('New temporary chat')}");
    // Decision 174 (issue #6, second wave): like every 「新建」 it opens the
    // home page — here with 「不选仓库（临时对话）」 picked — and the
    // temporary chat is made by its first send, so no empty shell is made.
    // Twice: the menu item and the header's hover 「＋」 (§2.9).
    expect(temporaryGroup.split("openHome({ kind: 'unbound' })").length - 1).toBe(2);
    expect(temporaryGroup).toContain("aria-label={t('New temporary chat')}");
    expect(temporaryGroup).not.toContain('createOrReuseUnboundChatSession');
  });

  it('the list offers Add Repository on its blank space', () => {
    // From the Root around the list area down to its menu.
    const listAt = nav.indexOf('render={<div className={LIST_AREA_CLASS} />}');
    expect(listAt).toBeGreaterThan(-1);
    const list = nav.slice(
      nav.lastIndexOf('<ContextMenuPrimitive.Root>', listAt),
      nav.indexOf('</ContextMenuPrimitive.Root>', nav.indexOf('</ScrollArea>', listAt))
    );
    // It holds every group, so the menu covers the gaps between them.
    expect(list).toContain('{renderTemporaryGroup()}');
    expect(list).toContain('visibleFolders.map(renderRepositoryGroup)');
    expect(list).toContain('onClick={() => onAddRepository?.()}');
    expect(list).toContain("{t('Add Repository')}");
  });

  it('keeps the visible buttons — the menu is a second way in, not a replacement', () => {
    // Right-click alone is undiscoverable; the top nav's 「仓库」 (layout 5b:
    // its menu ends in 「添加仓库」) and the repository header's "more" button
    // both stay.
    const repositories = nav.slice(
      nav.indexOf('<MenuTrigger render={<button type="button" className={NAV_ITEM_CLASS} />}>'),
      nav.indexOf("{t('Skills and plugins')}")
    );
    expect(repositories).toContain("{t('Repositories')}");
    expect(repositories).toContain('onClick={() => onAddRepository?.()}');
    expect(repositories).toContain("{t('Add Repository')}");
    expect(nav).toContain("aria-label={t('Repository actions')}");
  });
});

describe('S2 project row context menu', () => {
  it('shares one definition of the actions with the more button', () => {
    // Layout 5b: one function, so the 「仓库」 entry's submenu renders it too.
    expect(nav).toContain(
      'const repoMenuItems = folderRepo ? repositoryMenuItems(folderRepo) : null;'
    );
    // Every entry point renders the same value. A second literal copy is the
    // failure this guards: they would drift the first time either changed.
    expect(nav).toContain('<MenuPopup align="end">{repoMenuItems}</MenuPopup>');
    expect(nav).toContain('<ContextMenuPrimitive.Trigger render={header} />');
    expect(nav).toContain('{repositoryMenuItems(repo)}');
    const items = nav.slice(
      nav.indexOf('const repositoryMenuItems = (repo: Repository) => ('),
      nav.indexOf('const renderRepositoryGroup')
    );
    expect(items).toContain("{t('Repository Settings')}");
    expect(items).toContain("{t('Remove repository')}");
  });

  it('leaves a folder with no repository un-wrapped, so its right-click falls through', () => {
    // The synthetic Temp project has no repository behind it. Wrapping it
    // anyway would give it a trigger with an empty menu, and Base UI's trigger
    // stops the event — the list menu would never be reached from that row.
    expect(nav).toContain('{repoMenuItems ? (');
    // The else branch is the bare header, with no trigger around it.
    expect(nav).toMatch(/\) : \(\s*header\s*\)}/);
  });

  it('the header is a DOM element the trigger can put its props on', () => {
    // `render={header}` needs an element, so the shared header is a function
    // returning one, not a component.
    expect(nav).toContain('function renderGroupHeader({');
    expect(nav).toContain('const header = renderGroupHeader({');
  });
});
