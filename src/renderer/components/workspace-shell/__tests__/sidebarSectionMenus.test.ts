import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * H/18 S1 + S2 — the sidebar's two PARTITION menus and the project-row menu.
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
 * opens the row's menu and not the partition's, and why a trigger with NO menu
 * behind it would be a trap — it would swallow the event and leave the user
 * with nothing.
 */
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);

/** Source of the temporary-chat partition, which is one self-contained helper. */
const unboundSection = (() => {
  const start = nav.indexOf('const renderUnboundSection');
  return nav.slice(start, nav.indexOf('\n  };', start));
})();

describe('S1 partition context menus', () => {
  it('the temporary-chat partition offers a new temporary chat', () => {
    expect(unboundSection).toContain('<ContextMenuPrimitive.Root>');
    // Rendered AS the <section>, so the menu covers the header and the gaps
    // between rows rather than adding a wrapper element with its own box.
    expect(unboundSection).toContain('render={<section />}');
    expect(unboundSection).toContain("{t('New temporary chat')}");
    expect(unboundSection).toContain('createUnboundChatSession()');
  });

  it('the projects partition offers Add Repository', () => {
    // From the Root that opens before the "Repositories" title down to where
    // the temporary-chat partition begins — i.e. the whole projects region,
    // title row and folder list included.
    const titleAt = nav.indexOf("{t('Repositories')}");
    const partition = nav.slice(
      nav.lastIndexOf('<ContextMenuPrimitive.Root>', titleAt),
      nav.indexOf('{renderUnboundSection()}', titleAt)
    );
    expect(partition).toContain('<ContextMenuPrimitive.Trigger className="space-y-3">');
    expect(partition).toContain('onClick={() => onAddRepository?.()}');
    expect(partition).toContain("{t('Add Repository')}");
  });

  it('keeps the header buttons — the menu is a second way in, not a replacement', () => {
    // Right-click alone is undiscoverable; the "Add Repository" button and the
    // repository row's "more" button both stay.
    expect(nav).toContain("title={t('Add Repository')}");
    expect(nav).toContain("aria-label={t('Repository actions')}");
  });
});

describe('S2 project row context menu', () => {
  it('shares one definition of the actions with the more button', () => {
    expect(nav).toContain('const repoMenuItems = folderRepo ? (');
    // Both entry points render the same value. A second literal copy is the
    // failure this guards: the two would drift the first time either changed.
    expect(nav).toContain('<MenuPopup align="end">{repoMenuItems}</MenuPopup>');
    expect(nav).toContain('<ContextMenuPrimitive.Trigger render={header} />');
    const items = nav.slice(
      nav.indexOf('const repoMenuItems = folderRepo ? ('),
      nav.indexOf(') : null;')
    );
    expect(items).toContain("{t('Repository Settings')}");
    expect(items).toContain("{t('Remove repository')}");
  });

  it('leaves a folder with no repository un-wrapped, so its right-click falls through', () => {
    // The synthetic Temp project has no repository behind it. Wrapping it
    // anyway would give it a trigger with an empty menu, and Base UI's trigger
    // stops the event — the projects-partition menu would never be reached from
    // that row.
    expect(nav).toContain('{repoMenuItems ? (');
    // The else branch is the bare header, with no trigger around it.
    expect(nav).toMatch(/\) : \(\s*header\s*\)}/);
  });
});
