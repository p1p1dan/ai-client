import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Decision 167 (GitHub issue #3) and decision 170 (GitHub issue #6): the
 * 「聊天」 panel's five-level hierarchy and its three regions, as the approved
 * prototypes measured them
 * (`docs/plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/`,
 * `.../sidebar-regions-2026-10/`) and `docs/design-system.md`
 * 「侧栏层级（聊天面板）」 states them. Static, like this directory's other
 * LeftNav pins: what can regress is a class string, and jsdom computes no
 * layout to measure.
 *
 *   L0 panel title   16px 600 foreground       h-9   (`DockTitle`, every panel)
 *   L1 region title  16px 600 foreground       h-8   outside its region's scroll area
 *   L2 folder        15px 600 foreground       h-7   folder icon size-4
 *   L3 chat          14px 400 foreground-soft  h-7   fixed w-4 status slot; open: foreground
 *   L4 auxiliary     14px 400 muted            h-6   when on a line of its own
 */

const SHELL = join(process.cwd(), 'src/renderer/components/workspace-shell');
const COMPONENTS = join(process.cwd(), 'src/renderer/components');

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

const NAV = code(join(SHELL, 'LeftNav.tsx'));
const DOCK = code(join(SHELL, 'LeftDock.tsx'));
const BAR = code(join(SHELL, 'SessionBar.tsx'));

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(to, start));
}

const DOCK_TITLE = slice(DOCK, 'function DockTitle(', '\n}\n');
const SECTION_HEADER = slice(NAV, 'function SidebarSectionHeader(', '\n}\n');
const AUX_ROW = slice(NAV, 'function SidebarAuxRow(', '\n}\n');
const ROW = NAV.slice(NAV.indexOf('function SessionRow('));
/** The three region helpers / blocks, each from its opening to the next. */
const ACTIVE_REGION = slice(NAV, 'const renderActiveRegion = () => {', '\n  };\n');
const TEMPORARY_REGION = slice(NAV, 'const renderUnboundSection = () => {', '\n  };\n');
const LIST_AREA = slice(
  NAV,
  '<div className="flex min-h-0 flex-1 flex-col">',
  '{renderUnboundSection()}'
);
const REPOSITORIES_REGION = LIST_AREA.slice(LIST_AREA.indexOf('<ContextMenuPrimitive.Root>'));

/** The literal value of a `const NAME = '…';` in LeftNav (one string, maybe wrapped). */
function constant(name: string): string {
  const match = new RegExp(`const ${name} =\\s*'([^']*)';`).exec(NAV);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
}

describe('weights: 400 and 600 only (design system, Font Weight)', () => {
  it('no hierarchy carrier in the sidebar, the dock title or the session bar title uses 500', () => {
    // Microsoft YaHei UI has no 500: CJK renders it as 400 on Windows 10 and
    // 11 alike, so a 500 level is invisible there. Button / Badge primitives
    // carry their own `font-medium`; these files must not add one.
    expect(NAV).not.toContain('font-medium');
    expect(DOCK_TITLE).not.toContain('font-medium');
    expect(BAR).not.toContain('font-medium');
  });

  it('L0: the dock title is 16px / 600, no tracking, on the h-9 bar', () => {
    expect(DOCK_TITLE).toContain(
      '<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">'
    );
    expect(DOCK_TITLE).toContain('className="min-w-0 flex-1 truncate text-section font-semibold"');
    expect(DOCK_TITLE).not.toContain('tracking-');
    expect(DOCK_TITLE).not.toContain('text-ui');
  });

  it('the session bar title on the same h-9 line is 16px / 400 — weight tells them apart', () => {
    expect(BAR).toContain('<span className="min-w-0 truncate text-section text-foreground">');
  });

  it('L1: region titles are 16px / 600 / foreground, +0.04em, h-8', () => {
    expect(SECTION_HEADER).toContain('<div className="flex h-8 items-center px-4">');
    expect(SECTION_HEADER).toContain(
      'className="min-w-0 truncate text-section font-semibold tracking-[0.04em] text-foreground"'
    );
    expect(SECTION_HEADER).not.toContain('text-muted-foreground">');
    // All three regions use it; none hand-rolls a title row.
    for (const title of ["{t('Active now')}", "{t('Repositories')}", '{unboundFolder.name}']) {
      expect(NAV).toContain(`<SidebarSectionHeader title=${title}>`);
    }
    expect(NAV).not.toContain("{t('Recent')}");
    expect(NAV).not.toContain('tracking-[0.04em] text-muted-foreground');
  });

  it('L2: the folder name is 15px / 600 with a size-4 folder icon; the branch after it is L4', () => {
    expect(NAV).toContain(
      'className="group flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-ui hover:bg-hover has-focus-visible:bg-hover"'
    );
    expect(NAV).toContain('data-slot="sidebar-folder-name"');
    expect(NAV).toContain('className="min-w-0 truncate font-semibold"');
    expect(NAV).toContain('<FolderOpen className="size-4 shrink-0 text-folder" />');
    expect(NAV).toContain('<Folder className="size-4 shrink-0 text-folder" />');
    expect(NAV).toContain(
      'className="min-w-0 shrink-[1000] truncate text-meta text-muted-foreground"'
    );
  });

  it('L3: a chat row is 14px / 400 in --foreground-soft; the open one keeps the body colour', () => {
    expect(ROW).toContain(
      "'group flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-sm px-2 text-left text-meta',"
    );
    expect(ROW).toContain("? 'bg-selection text-accent-foreground'");
    expect(ROW).toContain(": 'text-foreground-soft hover:bg-hover focus-visible:bg-hover'");
    // The token is alpha-free and takes no /N (design system, Alpha discipline).
    expect(NAV).not.toMatch(/text-foreground-soft\/\d/);
    // The rename editor that replaces the row keeps its size.
    expect(ROW).toContain(
      'className="h-6 flex-1 rounded-sm text-meta before:rounded-[calc(var(--radius-sm)-1px)]"'
    );
  });

  it('L4: auxiliary rows are 14px muted, h-6, and the segment labels are gone', () => {
    expect(AUX_ROW).toContain(
      'className="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"'
    );
    // The same w-4 slot as a chat row, so the text lines up with the titles.
    expect(AUX_ROW).toContain('className="flex w-4 shrink-0 items-center justify-center"');
    // Decision 170: no 「正在活动」 / 「48 小时内」 segment labels any more.
    expect(NAV).not.toContain('SidebarSegmentLabel');
    expect(NAV).not.toContain("t('Last 48 hours')");
    // The old h-7, 15px, `pl-5` "View more" is gone.
    expect(NAV).not.toContain('pl-5');
  });

  it('only the 14 / 15 / 16 tiers, nothing smaller than 14px (CJK cascade rule 3)', () => {
    expect(NAV).not.toMatch(/\btext-(xs|2xs|sm|base|lg|title)\b/);
    // `Button size="xs"` is 12px on desktop (`sm:text-xs`): every one here
    // overrides it with `sm:text-meta`.
    const xsButtons = [...NAV.matchAll(/<Button[^>]*size="xs"[^>]*>/g)].map((match) => match[0]);
    expect(xsButtons.length).toBeGreaterThanOrEqual(5);
    for (const button of xsButtons) expect(button).toContain('sm:text-meta');
  });
});

describe('three regions (decision 170, issue #6 ruling 1)', () => {
  it('each region is a two-row grid: its title, then its own scroll area', () => {
    const grid = 'grid-cols-1 grid-rows-[auto_minmax(0,1fr)]';
    expect(constant('ACTIVE_REGION_CLASS')).toBe(`grid max-h-[33%] min-h-0 shrink-0 ${grid}`);
    expect(constant('REPOSITORIES_REGION_CLASS')).toBe(`grid min-h-0 flex-1 ${grid}`);
    expect(constant('TEMPORARY_REGION_CLASS')).toBe(
      `grid max-h-[25%] min-h-0 shrink-0 ${grid} border-t`
    );
  });

  it('the regions sit in one flex column, in order: Active now, Repositories, Temporary chats', () => {
    // The `max-h-*` caps resolve against this column; it must stay the list
    // area itself (flex-1 min-h-0), with no content-sized wrapper around it.
    expect(NAV).toContain('<div className="flex min-h-0 flex-1 flex-col">');
    const active = LIST_AREA.indexOf('{renderActiveRegion()}');
    const repositories = LIST_AREA.indexOf('REPOSITORIES_REGION_CLASS');
    expect(active).toBeGreaterThan(-1);
    expect(repositories).toBeGreaterThan(active);
    expect(NAV.indexOf('{renderUnboundSection()}')).toBeGreaterThan(
      NAV.indexOf('REPOSITORIES_REGION_CLASS, activeRows.length > 0')
    );
    expect(ACTIVE_REGION).toContain('<section className={ACTIVE_REGION_CLASS}>');
    expect(TEMPORARY_REGION).toContain('render={<section className={TEMPORARY_REGION_CLASS} />}');
    // Repositories opens with a divider only when Active now is above it.
    expect(REPOSITORIES_REGION).toContain(
      "className={cn(REPOSITORIES_REGION_CLASS, activeRows.length > 0 && 'border-t')}"
    );
  });

  it('every title is outside its region s scroll area', () => {
    for (const region of [ACTIVE_REGION, TEMPORARY_REGION, REPOSITORIES_REGION]) {
      const header = region.indexOf('<SidebarSectionHeader');
      const scroll = region.indexOf('<ScrollArea');
      expect(header).toBeGreaterThan(-1);
      expect(scroll).toBeGreaterThan(header);
      expect(region.indexOf('</SidebarSectionHeader>')).toBeLessThan(scroll);
    }
  });

  it('Active now and Temporary chats fade at the bottom; Repositories does not', () => {
    expect(ACTIVE_REGION).toContain('<ScrollArea scrollFade="bottom">');
    expect(TEMPORARY_REGION).toContain('<ScrollArea scrollFade="bottom">');
    expect(REPOSITORIES_REGION).toContain('<ScrollArea>');
    expect(REPOSITORIES_REGION).not.toContain('scrollFade');
  });

  it('decision 167 s sticky machinery is gone with the shared scroll area', () => {
    expect(NAV).not.toContain('sticky');
    expect(NAV).not.toContain('bg-image-enabled');
    expect(NAV).not.toContain('bg-card/40');
    expect(NAV).not.toContain('isolate');
    expect(NAV).not.toContain('scroll-pt-8');
    expect(NAV).not.toContain('sidebarSectionClass');
  });

  it('spacing inside a region: px-2 pt-0.5 pb-2, folder groups space-y-1, rows space-y-0.5', () => {
    expect(NAV.split('<div className="px-2 pt-0.5 pb-2">').length - 1).toBe(3);
    expect(REPOSITORIES_REGION).toContain('<div className="space-y-1">');
    expect(ACTIVE_REGION).toContain('<div className="space-y-0.5">');
    expect(TEMPORARY_REGION).toContain('<div className="space-y-0.5">');
    expect(NAV).toContain('<div className="mt-0.5 space-y-0.5 pl-3">');
    expect(NAV).not.toContain('space-y-3');
  });

  it('Active now is not rendered while nothing is active, and folds from its title', () => {
    expect(ACTIVE_REGION).toContain('if (activeRows.length === 0) return null;');
    expect(ACTIVE_REGION).toContain("t('Expand active chats') : t('Collapse active chats')");
    expect(ACTIVE_REGION).toContain('{!activeCollapsed && (');
    // Memory only: nothing about it is stored.
    expect(NAV).not.toContain('localStorage');
  });

  it('Repositories title bar: Collapse all, Filter, Add — size-6 buttons, size-3.5 icons', () => {
    const header = slice(REPOSITORIES_REGION, '<SidebarSectionHeader', '</SidebarSectionHeader>');
    const order = [
      "t('Collapse all repositories')",
      "t('Filter sessions')",
      "t('Add Repository')",
    ].map((label) => header.indexOf(label));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(header).toContain('<ChevronsDownUp className="size-3.5" />');
    expect(header.split('className="size-6 text-muted-foreground"').length - 1).toBe(3);
  });

  it('Collapse all folds every folder by key and leaves the Temporary chats flag alone', () => {
    const handler = slice(NAV, 'const collapseAllFolders = () =>', '));\n');
    expect(handler).toContain('...prev,');
    expect(handler).toContain('folders.map((folder) => [folder.projectId, false])');
    expect(handler).not.toContain('visibleFolders');
    expect(handler).not.toContain('UNBOUND_FOLDER_ID');
  });

  it('the folder order is held while the pointer or keyboard focus is in Repositories', () => {
    expect(REPOSITORIES_REGION).toContain('{...reposHold.regionProps}');
    expect(NAV).toContain('const reposHold = useRegionHold(!showAddRepositoryEmptyState);');
    expect(NAV).toContain('applyHeldFolderOrder(liveFolderOrder, heldFolderOrder)');
    const hook = slice(NAV, 'function useRegionHold(', '\n}\n');
    expect(hook).toContain('onPointerEnter: () => setPointerInside(true)');
    expect(hook).toContain('onPointerLeave: () => setPointerInside(false)');
    expect(hook).toContain('setKeyboardFocus(hasKeyboardFocus(event.target))');
    // A removed focused element sends no blur: the after-commit check lets go.
    expect(hook).toContain('document.activeElement !== focusTargetRef.current');
    // Keyboard focus only — not the focus a click leaves behind.
    expect(slice(NAV, 'function hasKeyboardFocus(', '\n}\n')).toContain("':focus-visible'");
  });
});

describe('rows', () => {
  it('h-6 / h-7 rows and controls use rounded-sm, never rounded-md or larger', () => {
    // The radius clamp rule: 10px on a 28px row is close to a pill, and
    // `rounded-lg` on h-7 is one.
    expect(NAV).not.toMatch(/\brounded-(md|lg|xl)\b/);
  });

  it('a chat row has a keyboard focus style, and it is the hover step', () => {
    expect(ROW).toContain(": 'text-foreground-soft hover:bg-hover focus-visible:bg-hover'");
  });

  it('every chat row says where it is and when, in its tooltip', () => {
    expect(ROW).toContain('title={tooltip}');
    expect(ROW).toContain('sidebarRowTooltip({');
    // Three lists: Active now, the folders, Temporary chats.
    expect(NAV.split('place={placeOf(row)}').length - 1).toBe(3);
  });
});

/**
 * Issue #3 item 5: the absolutely positioned magnifier placed BEFORE an
 * `Input` is painted over by the input's `relative`, opaque wrapper — in the
 * light theme the icon never showed. The fix is coss's InputGroup with the
 * input first and the addon after it (`order-first` draws it on the left, and
 * the addon's `[data-size=sm]+&` padding only matches in that order).
 */
describe('search fields: InputGroup, input first (decision 167)', () => {
  const SEARCH_FIELDS = [
    join(SHELL, 'LeftNav.tsx'),
    join(COMPONENTS, 'chat/ComposerModelTrigger.tsx'),
    join(COMPONENTS, 'source-control/BranchSwitcher.tsx'),
  ];

  it.each(SEARCH_FIELDS)('%s puts InputGroupInput before InputGroupAddon', (file) => {
    const source = code(file);
    const input = source.indexOf('<InputGroupInput');
    const addon = source.indexOf('<InputGroupAddon align="inline-start">');
    expect(input).toBeGreaterThan(-1);
    expect(addon).toBeGreaterThan(input);
    const group = slice(source, '<InputGroup ', '>');
    expect(group).toContain('h-7 rounded-sm before:rounded-[calc(var(--radius-sm)-1px)]');
    expect(source.slice(input, source.indexOf('/>', input))).toContain('size="sm"');
  });

  it('no renderer component draws an absolutely positioned icon before an Input', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.tsx')) {
          const source = code(full);
          if (/<[A-Z]\w*\s+className="[^"]*\babsolute\b[^"]*"\s*\/>\s*<Input\b/.test(source)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(join(process.cwd(), 'src/renderer'));
    expect(offenders).toEqual([]);
  });

  it('the scan recognises the old shape', () => {
    const old =
      '<Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5" />\n<Input';
    expect(old).toMatch(/<[A-Z]\w*\s+className="[^"]*\babsolute\b[^"]*"\s*\/>\s*<Input\b/);
  });
});
