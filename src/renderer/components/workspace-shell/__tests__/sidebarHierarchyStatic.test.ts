import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Decision 167 (GitHub issue #3): the 「聊天」 panel's five-level hierarchy, as
 * the approved prototype measured it
 * (`docs/plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/`) and
 * `docs/design-system.md` 「侧栏层级（聊天面板）」 states it. Static, like this
 * directory's other LeftNav pins: what can regress is a class string, and
 * jsdom computes no layout to measure.
 *
 *   L0 panel title   15px 600 foreground  h-9   (`DockTitle`, every panel)
 *   L1 section title 15px 600 foreground  h-8   sticky in its section
 *   L2 folder        15px 600 foreground  h-7   folder icon size-4
 *   L3 chat          15px 400 foreground  h-7   fixed w-4 status slot
 *   L4 auxiliary     14px 400 muted       h-6   when on a line of its own
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
const SECTION_CLASS = slice(NAV, 'function sidebarSectionClass(', '\n}\n');
const AUX_ROW = slice(NAV, 'function SidebarAuxRow(', '\n}\n');
const SEGMENT_LABEL = slice(NAV, 'function SidebarSegmentLabel(', '\n}\n');
const ROW = NAV.slice(NAV.indexOf('function SessionRow('));

describe('weights: 400 and 600 only (design system, Font Weight)', () => {
  it('no hierarchy carrier in the sidebar, the dock title or the session bar title uses 500', () => {
    // Microsoft YaHei UI has no 500: CJK renders it as 400 on Windows 10 and
    // 11 alike, so a 500 level is invisible there. Button / Badge primitives
    // carry their own `font-medium`; these files must not add one.
    expect(NAV).not.toContain('font-medium');
    expect(DOCK_TITLE).not.toContain('font-medium');
    expect(BAR).not.toContain('font-medium');
  });

  it('L0: the dock title is 15px / 600, no tracking, on the h-9 bar', () => {
    expect(DOCK_TITLE).toContain(
      '<div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">'
    );
    expect(DOCK_TITLE).toContain('className="min-w-0 flex-1 truncate text-ui font-semibold"');
    expect(DOCK_TITLE).not.toContain('tracking-');
    expect(DOCK_TITLE).not.toContain('text-meta');
  });

  it('the session bar title on the same h-9 line is 15px / 400 — weight tells them apart', () => {
    expect(BAR).toContain('<span className="min-w-0 truncate text-ui text-foreground">');
  });

  it('L1: section titles are 15px / 600 / foreground, +0.04em, h-8', () => {
    expect(SECTION_HEADER).toContain('<div className="flex h-8 items-center bg-card/40 px-4">');
    expect(SECTION_HEADER).toContain(
      'className="min-w-0 truncate text-ui font-semibold tracking-[0.04em] text-foreground"'
    );
    expect(SECTION_HEADER).not.toContain('text-muted-foreground">');
    // All three sections use it; none hand-rolls a title row.
    for (const title of ["{t('Recent')}", "{t('Repositories')}", '{unboundFolder.name}']) {
      expect(NAV).toContain(`<SidebarSectionHeader title=${title}>`);
    }
    expect(NAV).not.toContain('tracking-[0.04em] text-muted-foreground');
  });

  it('L2: the folder name is 600 with a size-4 folder icon; the branch after it is L4', () => {
    expect(NAV).toContain('data-slot="sidebar-folder-name"');
    expect(NAV).toContain('className="min-w-0 truncate font-semibold"');
    expect(NAV).toContain('<FolderOpen className="size-4 shrink-0 text-folder" />');
    expect(NAV).toContain('<Folder className="size-4 shrink-0 text-folder" />');
    expect(NAV).toContain(
      'className="min-w-0 shrink-[1000] truncate text-meta text-muted-foreground"'
    );
  });

  it('L4: auxiliary rows and segment labels are 14px muted, h-6', () => {
    expect(AUX_ROW).toContain(
      'className="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"'
    );
    // The same w-4 slot as a chat row, so the text lines up with the titles.
    expect(AUX_ROW).toContain('className="flex w-4 shrink-0 items-center justify-center"');
    expect(SEGMENT_LABEL).toContain("'flex h-6 items-center px-2 text-meta text-muted-foreground'");
    // The old h-7, 15px, `pl-5` "View more" is gone.
    expect(NAV).not.toContain('pl-5');
  });

  it('nothing in the sidebar is smaller than 14px (CJK cascade rule 3)', () => {
    expect(NAV).not.toMatch(/\btext-(xs|2xs)\b/);
    // `Button size="xs"` is 12px on desktop (`sm:text-xs`): every one here
    // overrides it with `sm:text-meta`.
    const xsButtons = [...NAV.matchAll(/<Button[^>]*size="xs"[^>]*>/g)].map((match) => match[0]);
    expect(xsButtons.length).toBeGreaterThanOrEqual(5);
    for (const button of xsButtons) expect(button).toContain('sm:text-meta');
  });
});

describe('separation and the sticky section title', () => {
  it('sections are full-bleed, and all but the first open with mt-2 and a divider', () => {
    expect(SECTION_CLASS).toContain("cn('-mx-2 px-2', !first && 'mt-2 border-t')");
    expect(NAV).toContain('<section className={sidebarSectionClass(true)}>');
    expect(NAV.split('sidebarSectionClass(false)').length - 1).toBe(1);
    expect(NAV).toContain('render={<section className={sidebarSectionClass(first)} />}');
  });

  it('the title sticks within its section, opaque in the panel colour, and not with a background image', () => {
    expect(SECTION_HEADER).toContain(
      'className="sticky top-0 z-10 -mx-2 bg-background in-[.bg-image-enabled]:static"'
    );
    // `bg-background` + `bg-card/40` recompose the panel: LeftDock's root lays
    // the same `bg-card/40` over the shell's `bg-background`.
    expect(DOCK).toContain("'relative flex h-full shrink-0 bg-card/40',");
    expect(SECTION_HEADER).toContain('bg-card/40');
    // `.bg-image-enabled` is the body class `useBackgroundImage` toggles.
    const hook = readFileSync(
      join(process.cwd(), 'src/renderer/App/hooks/useBackgroundImage.ts'),
      'utf8'
    );
    expect(hook).toContain("body.classList.add('bg-image-enabled')");
  });

  it('nothing between the sticky title and the scroll viewport breaks sticky', () => {
    // overflow / transform / filter / contain on any ancestor up to the
    // viewport silently disables `position: sticky` (design system, the
    // timeline fold header's red line 3).
    const between = [SECTION_CLASS, NAV.slice(NAV.indexOf('<ScrollArea'), NAV.indexOf('<section'))];
    for (const source of between) {
      expect(source).not.toMatch(/\b(overflow-|transform|filter|blur-|contain-)/);
    }
  });

  it('the scroll viewport pads its top by the title height, so a focused row is not hidden', () => {
    expect(NAV).toContain(
      '<ScrollArea className="min-h-0 flex-1 *:data-[slot=scroll-area-viewport]:scroll-pt-8">'
    );
  });

  it('spacing: list p-2, folder groups space-y-1, rows space-y-0.5, first items mt-0.5', () => {
    expect(NAV).toContain('<div className="isolate p-2">');
    expect(NAV).toContain('<div className="mt-0.5 space-y-1">');
    expect(NAV).toContain('<div className="mt-0.5 space-y-0.5 pl-3">');
    expect(NAV).not.toContain('space-y-3');
    expect(NAV).not.toContain('mt-1 space-y-0.5');
  });
});

describe('rows', () => {
  it('h-6 / h-7 rows and controls use rounded-sm, never rounded-md or larger', () => {
    // The radius clamp rule: 10px on a 28px row is close to a pill, and
    // `rounded-lg` on h-7 is one.
    expect(NAV).not.toMatch(/\brounded-(md|lg|xl)\b/);
  });

  it('a chat row has a keyboard focus style, and it is the hover step', () => {
    expect(ROW).toContain(
      "active ? 'bg-selection text-accent-foreground' : 'hover:bg-hover focus-visible:bg-hover'"
    );
  });

  it('every chat row says where it is and when, in its tooltip', () => {
    expect(ROW).toContain('title={tooltip}');
    expect(ROW).toContain('sidebarRowTooltip({');
    expect(NAV.split('place={placeOf(row)}').length - 1).toBe(4);
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
