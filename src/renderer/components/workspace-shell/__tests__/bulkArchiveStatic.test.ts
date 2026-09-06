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

describe('U30 the permission menu closes on pick', () => {
  it('is controlled, and applying a tier closes it', () => {
    // `MenuPrimitive.RadioItem` does not close on select — radio semantics are
    // "keep flipping between these". Right for a filter, wrong for a decision:
    // the menu staying open reads as "that did not take".
    expect(PERMISSION).toContain('const [open, setOpen] = useState(false);');
    expect(PERMISSION).toContain('<Menu\n      open={open}');
    expect(PERMISSION).toContain('setOpen(false);');
  });

  it('closes from applyTier, so the dangerous tier keeps its confirmation step', () => {
    const applyTier = NAV.length > 0 ? PERMISSION.slice(PERMISSION.indexOf('const applyTier')) : '';
    const body = applyTier.slice(0, applyTier.indexOf('const handleSelect'));
    expect(body).toContain('setOpen(false);');
    // If the close moved into `handleSelect`, picking "full access" would shut
    // the menu before the confirmation could be shown.
    const handleSelect = PERMISSION.slice(PERMISSION.indexOf('const handleSelect'));
    expect(handleSelect.slice(0, handleSelect.indexOf('const handleConfirm'))).not.toContain(
      'setOpen(false)'
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
