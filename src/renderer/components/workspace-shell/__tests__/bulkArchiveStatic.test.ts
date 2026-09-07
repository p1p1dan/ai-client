import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * U30 / U31 — the batch that came out of the 2026-09-06 second point-check.
 *
 * All four are shape claims about JSX or class strings, which no pure test can
 * reach, so they are pinned against source the way `deadControlsStatic` pins
 * its own.
 */
const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};

const NAV = read('src/renderer/components/workspace-shell/LeftNav.tsx');
const INDEX = read('src/renderer/components/chat/sessionIndex/useSessionIndex.ts');
const PERMISSION = read('src/renderer/components/chat/ComposerPermissionTrigger.tsx');
const MODEL = read('src/renderer/components/chat/ComposerModelTrigger.tsx');
const LAYOUT = read('src/renderer/components/chat/middleColumnLayout.ts');
const EXTENSION_UI = read('src/renderer/components/chat/ExtensionUiDialog.tsx');

describe('U30 rev.2 the permission menu closes on pick', () => {
  /**
   * The regression this replaces shipped in 0.4.0-test.7 and the assertions it
   * came with were green the whole time: they pinned `open={open}` and
   * `setOpen(false)`, which is exactly what BROKE it.
   *
   * `MenuRoot.setOpen` (`@base-ui/react@1.1.0`) starts with
   * `if (open === nextOpen && …) return;`. Writing the controlled prop moves the
   * store's `open` without running that function, so afterwards every Escape and
   * outside-press hits the guard and returns — the popup stayed on screen with
   * no way to dismiss it. So the claim worth pinning is the absence of the
   * controlled prop, not the presence of a close call.
   */
  it('never controls `open`, because a prop write bypasses Base UI close bookkeeping', () => {
    expect(PERMISSION).not.toContain('open={open}');
    expect(PERMISSION).not.toContain('setOpen(');
    expect(PERMISSION).toContain('actionsRef={menuActions}');
  });

  it('lets Base UI close on an ordinary tier and keeps the dangerous one open', () => {
    // `closeOnClick` defaults to false on a radio item (radio semantics are
    // "keep flipping between these"); a tier is a decision, so every tier but
    // the one that still has to be confirmed closes on the press.
    expect(PERMISSION).toContain('closeOnClick={!option.dangerous}');
  });

  it('closes the confirmation step imperatively, since it is not a menu item', () => {
    const handleConfirm =
      NAV.length > 0 ? PERMISSION.slice(PERMISSION.indexOf('const handleConfirm')) : '';
    expect(handleConfirm.slice(0, 400)).toContain('menuActions.current?.close();');
    // If this moved into `handleSelect`, picking "full access" would shut the
    // menu before the confirmation could be shown.
    const handleSelect = PERMISSION.slice(PERMISSION.indexOf('const handleSelect'));
    expect(handleSelect.slice(0, handleSelect.indexOf('const handleConfirm'))).not.toContain(
      'menuActions.current'
    );
  });
});

describe('U30 the composer chrome stops moving', () => {
  it('the model popup hangs off the trigger edge the bar pins', () => {
    // The trigger sits in the bar's `ms-auto` trailing group: right edge fixed,
    // left edge floating with the label's width. A left-anchored popup jumped
    // sideways on every model or effort change.
    expect(MODEL).toContain('align="end"');
    expect(MODEL).not.toContain('align="start"');
  });

  it('the model label is width-capped and truncates', () => {
    expect(LAYOUT).toContain('inline-flex h-6 max-w-56 shrink-0 items-center gap-1');
    expect(LAYOUT).toContain("return 'min-w-0 truncate text-muted-foreground';");
  });

  it('the extension-ui option list clears the focus ring', () => {
    // `Button`'s ring is drawn 3px outside the box and takes no layout, so at
    // `gap-1` (4px) the autofocused first option overlapped its neighbour.
    expect(EXTENSION_UI).toContain('className="grid gap-2 px-3 pb-2"');
    expect(EXTENSION_UI).not.toContain('className="grid gap-1 px-3 pb-2"');
  });
});

describe('U31 bulk archive', () => {
  it('refetches the index once for the whole selection, not once per row', () => {
    // The operation exists for "too many sessions", which is exactly when a
    // refetch per row is worst.
    const body = INDEX.slice(INDEX.indexOf('const archiveMany'));
    const fn = body.slice(0, body.indexOf('return { rename'));
    expect(fn).toContain('const withoutRefresh = async () => undefined;');
    expect(fn).toContain('archiveSessionIndexEntry(sessionId, true, withoutRefresh)');
    expect(fn.lastIndexOf('await refresh();')).toBeGreaterThan(fn.indexOf('for (const sessionId'));
    expect(INDEX).toContain('return { rename, archive, archiveMany, close };');
  });

  it('selection mode is one nullable Set, not a boolean beside a Set', () => {
    // A boolean plus a Set has an illegal fourth state ("not selecting, but
    // things are selected") every reader would have to interpret.
    expect(NAV).toContain('useState<ReadonlySet<string> | null>(null)');
    expect(NAV).toContain('const selecting = selection !== null;');
  });

  it('a row enters selection mode by being handed the callback, not a flag', () => {
    expect(NAV).toContain('onToggleSelect?: (sessionId: string) => void;');
    expect(NAV).toContain(
      'onClick={() => (onToggleSelect ? onToggleSelect(row.sessionId) : onSelect())}'
    );
  });

  it('asks before archiving and says how many', () => {
    expect(NAV).toContain('<AlertDialog open={bulkArchiveOpen}');
    expect(NAV).toContain("t('Archive {{count}} sessions? They will be removed from the sidebar.'");
    expect(NAV).toContain('void archiveMany(ids);');
  });

  it('keeps one row height: the checkbox takes the run-dot slot rather than adding one', () => {
    expect(NAV).toContain('{onToggleSelect ? null : row.busy ? (');
  });
});
