import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * Decision 183 (prototype
 * `docs/plantree/plans/dsh-rebase/evidence/sidebar-claude-style-2026-10/`,
 * default view) and `docs/design-system.md` 「侧栏层级（聊天面板）」: the
 * 「聊天」 panel after the redesign that replaced decision 170's three regions.
 * Static, like this directory's other LeftNav pins: what can regress is a
 * class string, and jsdom computes no layout to measure.
 *
 *   top nav       15px 400 foreground       h-8   22px icon slot; hover bg-hover
 *   tool row      search (h-7) + collapse / expand all + bulk archive (28px)
 *   group label   14px 400 muted            h-7   no icon, no hover fill; soft ink on hover
 *   chat          14px 400 foreground-soft  h-7   fixed w-4 status slot; open: foreground
 *   auxiliary     14px 400 muted            h-7   text in the title column
 *
 * Gone: the panel title (`DockTitle`, all five panels), the region titles
 * (`SidebarSectionHeader`), 「正在活动」, the dividers and the 16px tier.
 */

const SHELL = join(process.cwd(), 'src/renderer/components/workspace-shell');
const COMPONENTS = join(process.cwd(), 'src/renderer/components');

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

const NAV = code(join(SHELL, 'LeftNav.tsx'));
const DOCK = code(join(SHELL, 'LeftDock.tsx'));
const BAR = code(join(SHELL, 'SessionBar.tsx'));
const FOOTER = code(join(SHELL, 'UserFooterPill.tsx'));

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf(to, start));
}

const GROUP_HEADER = slice(NAV, 'function renderGroupHeader(', '\n}\n');
const GROUP_SUMMARY = slice(NAV, 'function GroupSummaryMarks(', '\n}\n');
const AUX_ROW = slice(NAV, 'function SidebarAuxRow(', '\n}\n');
const ROW = NAV.slice(NAV.indexOf('function SessionRow('));
const TEMPORARY_GROUP = slice(NAV, 'const renderTemporaryGroup = () => {', '\n  };\n');
const REPOSITORY_GROUP = slice(NAV, 'const renderRepositoryGroup = (', '\n  };\n');
const LIST_AREA = slice(NAV, 'render={<div className={LIST_AREA_CLASS} />}', '</ScrollArea>');

/** The literal value of a `const NAME = '…';` in LeftNav (one string, maybe wrapped). */
function constant(name: string): string {
  const match = new RegExp(`const ${name} =\\s*'([^']*)';`).exec(NAV);
  expect(match, name).not.toBeNull();
  return match?.[1] ?? '';
}

describe('weights: 400 and 600 only (design system, Font Weight)', () => {
  it('no hierarchy carrier in the sidebar, the dock or the session bar title uses 500', () => {
    // Microsoft YaHei UI has no 500: CJK renders it as 400 on Windows 10 and
    // 11 alike, so a 500 level is invisible there. Button / Badge primitives
    // carry their own `font-medium`; these files must not add one.
    expect(NAV).not.toContain('font-medium');
    expect(DOCK).not.toContain('font-semibold');
    expect(BAR).not.toContain('font-medium');
  });

  it('the session bar title stays 16px / 400', () => {
    expect(BAR).toContain('<span className="min-w-0 truncate text-section text-foreground">');
  });

  it('no level of the chat sidebar is bold any more: group labels are the grey 400 label', () => {
    expect(NAV).not.toContain('font-semibold');
  });
});

describe('the panel title is gone from all five panels (decision 183 §1.9)', () => {
  it('LeftDock renders no DockTitle, and names the panel through its region', () => {
    expect(DOCK).not.toContain('DockTitle');
    expect(DOCK).not.toContain('text-section');
    expect(DOCK).not.toContain('border-b px-3');
    // §2.7: the region keeps the panel name for screen readers.
    expect(DOCK).toContain('aria-label={t(descriptor.labelKey)}');
  });
});

describe('levels (decision 183, prototype `.vA`)', () => {
  it('top nav: two h-8 rows, 15px, a 22px icon slot; New chat on a round bg-selection disc', () => {
    expect(constant('NAV_ITEM_CLASS')).toBe(
      'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-ui hover:bg-hover focus-visible:bg-hover'
    );
    expect(NAV.split('className={NAV_ITEM_CLASS}').length - 1).toBe(2);
    expect(NAV).toContain(
      'className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-selection text-foreground"'
    );
    expect(NAV).toContain('<FolderPlus className="size-4" />');
    // New chat opens the home page (decision 174); Add repository the dialog.
    expect(NAV).toContain('onClick={handleNewSession}');
    expect(NAV).toContain('onClick={onAddRepository}');
  });

  it('group label: 14px / 400 / muted, soft ink on hover, no icon, no hover fill', () => {
    expect(GROUP_HEADER).toContain(
      '<div className="group flex h-7 w-full items-center gap-1 rounded-sm px-2 has-focus-visible:bg-hover">'
    );
    expect(GROUP_HEADER).toContain(
      'className="flex min-w-0 flex-1 items-center gap-1 text-left text-meta text-muted-foreground group-hover:text-foreground-soft group-has-focus-visible:text-foreground-soft"'
    );
    expect(GROUP_HEADER).toContain('aria-expanded={expanded}');
    expect(GROUP_HEADER).not.toContain('hover:bg-hover');
    expect(NAV).not.toContain('text-folder');
    expect(NAV).not.toMatch(/<Folder(Open)?\b/);
  });

  it('group chevron: ▸ always while folded, ▾ only on hover or keyboard focus while open', () => {
    expect(GROUP_HEADER).toContain(
      "expanded && 'opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100'"
    );
    expect(GROUP_HEADER).toContain(
      '{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}'
    );
    // The summary shows only while folded.
    expect(GROUP_HEADER).toContain(
      '{!expanded && summary && <GroupSummaryMarks summary={summary} />}'
    );
  });

  it('group header right side: totals and hover buttons share one grid cell', () => {
    expect(GROUP_HEADER).toContain('<span className="grid shrink-0 justify-items-end">');
    expect(GROUP_HEADER).toContain(
      'className="col-start-1 row-start-1 flex items-center group-hover:invisible group-has-focus-visible:invisible"'
    );
    expect(constant('GROUP_ACTION_CLASS')).toBe(
      'size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 sm:size-5'
    );
    // The ··· stays up while its menu is open.
    expect(REPOSITORY_GROUP).toContain(
      "className={cn(GROUP_ACTION_CLASS, 'data-popup-open:opacity-100')}"
    );
  });

  it('hover-only reveals answer keyboard focus, never the focus a click leaves behind', () => {
    // `focus-within` also matches a mouse click's focus, which kept the
    // actions, totals swap and ▾ up after the pointer had left the row or
    // header. Keyboard focus only: `group-focus-visible` on a focusable
    // group, `group-has-focus-visible` for a focusable descendant.
    expect(NAV).not.toContain('focus-within');
    expect(GROUP_HEADER).toContain('group-has-focus-visible:opacity-100');
    expect(ROW).toContain('group-focus-visible:flex group-has-focus-visible:flex');
  });

  it('Temporary chats and every repository use the one header', () => {
    expect(TEMPORARY_GROUP).toContain('renderGroupHeader({');
    expect(REPOSITORY_GROUP).toContain('renderGroupHeader({');
    expect(NAV).not.toContain('SidebarSectionHeader');
    // A repository header no longer names the main branch (§2.3).
    expect(NAV).not.toContain('folderBranchLabel');
    expect(REPOSITORY_GROUP).toContain('tooltip: folderTooltip(folderName, primary, t)');
  });

  it('folded summary: spinner with count, waiting dot, red or green dot (§2.2)', () => {
    expect(GROUP_SUMMARY).toContain('className="size-3 shrink-0 text-status-running"');
    expect(GROUP_SUMMARY).toContain('{summary.running > 1 && summary.running}');
    expect(GROUP_SUMMARY).toContain('className="size-1.5 shrink-0 rounded-full bg-warning"');
    expect(GROUP_SUMMARY).toContain(
      "summary.unread === 'failed' ? 'bg-destructive' : 'bg-success'"
    );
    expect(NAV).toContain('summary: deriveGroupSummary(folder.rows, unreadSessionIds)');
    expect(NAV).toContain('summary: deriveGroupSummary(unboundFolder.rows, unreadSessionIds)');
  });

  it('chat: 14px / 400 in --foreground-soft; the open one keeps the body colour', () => {
    expect(ROW).toContain(
      "'group relative flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-sm px-2 text-left text-meta',"
    );
    expect(ROW).toContain("? 'bg-selection text-accent-foreground'");
    expect(ROW).toContain(": 'text-foreground-soft hover:bg-hover focus-visible:bg-hover'");
    // The token is alpha-free and takes no /N (design system, Alpha discipline).
    expect(NAV).not.toMatch(/text-foreground-soft\/\d/);
    expect(NAV).not.toMatch(/muted-foreground-faint\/\d/);
    // The rename editor that replaces the row keeps its size.
    expect(ROW).toContain(
      'className="h-6 flex-1 rounded-sm text-meta before:rounded-[calc(var(--radius-sm)-1px)]"'
    );
  });

  it('a chat not started shows the faint ring; started, the muted one (§1.7)', () => {
    expect(ROW).toContain(
      'className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground-faint"'
    );
    expect(ROW).toContain("title={t('Not started')}");
    expect(ROW).toContain(
      'className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground"'
    );
    // Every branch of the slot renders a mark: no `: null}` at its end.
    const slot = slice(ROW, '{onToggleSelect ? null : row.busy ? (', '{titleParts.suffix === null');
    expect(slot).toContain('border-muted-foreground-faint');
    expect(slot).not.toContain(') : null}');
  });

  it('auxiliary: h-7, 14px muted, the empty w-4 slot puts the text in the title column', () => {
    expect(AUX_ROW).toContain(
      'className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"'
    );
    expect(AUX_ROW).toContain('className="flex w-4 shrink-0 items-center justify-center"');
    // §1.5: no 「新建对话」 row in an empty group, so no icon slot content.
    expect(AUX_ROW).not.toContain('icon');
    expect(NAV).not.toContain('icon={<Plus');
  });

  it('only the 14 / 15 tiers, nothing smaller than 14px (CJK cascade rule 3)', () => {
    expect(NAV).not.toMatch(/\btext-(xs|2xs|sm|base|lg|title|section)\b/);
    // `Button size="xs"` is 12px on desktop (`sm:text-xs`): every one here
    // overrides it with `sm:text-meta`.
    const xsButtons = [...NAV.matchAll(/<Button[^>]*size="xs"[^>]*>/g)].map((match) => match[0]);
    expect(xsButtons.length).toBeGreaterThanOrEqual(3);
    for (const button of xsButtons) expect(button).toContain('sm:text-meta');
  });
});

describe('one list (decision 183 §1.10)', () => {
  it('is a single-row grid holding one ScrollArea', () => {
    expect(constant('LIST_AREA_CLASS')).toBe(
      'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]'
    );
    expect(NAV.split('<ScrollArea').length - 1).toBe(1);
    expect(LIST_AREA).toContain('<ScrollArea>');
    expect(NAV).not.toContain('scrollFade');
  });

  it('Temporary chats first, then the repositories (or the add-repository card)', () => {
    const temporary = LIST_AREA.indexOf('{renderTemporaryGroup()}');
    const repositories = LIST_AREA.indexOf('visibleFolders.map(renderRepositoryGroup)');
    const card = LIST_AREA.indexOf('<Empty ');
    expect(temporary).toBeGreaterThan(-1);
    expect(repositories).toBeGreaterThan(temporary);
    expect(card).toBeGreaterThan(temporary);
  });

  it('the regions, their titles, dividers, caps and fades are gone', () => {
    for (const gone of [
      'renderActiveRegion',
      'renderUnboundSection',
      'ACTIVE_REGION_CLASS',
      'REPOSITORIES_REGION_CLASS',
      'TEMPORARY_REGION_CLASS',
      'activeCollapsed',
      'activeShowAll',
      'deriveActiveRows',
      'limitActiveRows',
      "t('Active now')",
      "t('Repositories')",
      'max-h-[',
      'sticky',
      'isolate',
    ]) {
      expect(NAV, gone).not.toContain(gone);
    }
    // Groups and rows are separated by spacing alone: the only line in the
    // panel body is the top zone's (below).
    expect(NAV).not.toMatch(/\bborder-t\b/);
    expect(NAV.match(/\bborder-b\b/g)).toHaveLength(1);
  });

  it('two full-width zone lines: under the top zone and on the account footer (user ruling 2026-10-12)', () => {
    // Prototype v6 `.sep-line`: 8px under the search row, one hairline on the
    // full-width box (its px-2 sits inside the line), shared by the selection
    // bar so nothing moves when multi-select starts.
    expect(constant('TOP_ZONE_END_CLASS')).toBe('shrink-0 border-b px-2 pt-1.5 pb-2');
    expect(NAV.split('className={TOP_ZONE_END_CLASS}').length - 1).toBe(1);
    const zone = slice(NAV, '<div className={TOP_ZONE_END_CLASS}>', '<ContextMenuPrimitive.Root>');
    expect(zone).toContain('<div className="flex h-7 items-center gap-0.5">');
    expect(zone).toContain('{selecting ? (');
    expect(zone).toContain('<InputGroup className={SIDEBAR_SEARCH_CLASS}>');
    // The footer's line is its own top border, across the panel.
    expect(FOOTER).toContain('<div className="flex shrink-0 items-center gap-1 border-t p-2">');
  });

  it('spacing: list px-2 pt-0.5 pb-3; groups 8px then 14px apart; rows 2px; no indent', () => {
    expect(LIST_AREA).toContain('<div className="px-2 pt-0.5 pb-3">');
    expect(constant('SIDEBAR_GROUP_CLASS')).toBe('mt-3.5 first:mt-2');
    expect(constant('GROUP_ROWS_CLASS')).toBe('mt-0.5 space-y-0.5');
    expect(NAV).not.toContain('pl-3');
    expect(TEMPORARY_GROUP).toContain('className={GROUP_ROWS_CLASS}');
    expect(REPOSITORY_GROUP).toContain('className={GROUP_ROWS_CLASS}');
  });

  it('the group order is held while the pointer or keyboard focus is in the list', () => {
    expect(NAV).toContain('{...listHold.regionProps}');
    expect(NAV).toContain('const listHold = useRegionHold(!showAddRepositoryEmptyState);');
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

  it('an empty repository group shows its header only (§1.5)', () => {
    expect(REPOSITORY_GROUP).toContain('{expanded && limited.rows.length > 0 && (');
    expect(NAV).not.toContain('folder.rows.length === 0 &&');
  });
});

describe('the tool row (decision 183 §1.8, §2.1)', () => {
  it('the search box is always there: no filter toggle, no visibility state', () => {
    expect(NAV).not.toContain('searchVisible');
    expect(NAV).not.toContain("t('Filter sessions')");
    expect(NAV).not.toContain('ListFilter');
    expect(NAV).toContain('<InputGroup className={SIDEBAR_SEARCH_CLASS}>');
  });

  it('the search box is drawn like the prototype, overriding the primitive by matching stacks', () => {
    // User ruling 2026-10-11: prototype `.search`, not InputGroup's default.
    // Each override repeats the variant stack of the base class it replaces,
    // so tailwind-merge drops the base one (the rendered result is asserted in
    // sidebarActiveAndFolders.test.ts). No `!important`.
    const focus = 'has-[input:focus-visible,textarea:focus-visible]';
    expect(constant('SIDEBAR_SEARCH_CLASS')).toBe(
      [
        'h-7 min-w-0 flex-1 rounded-sm border-border bg-transparent shadow-none before:hidden dark:bg-transparent',
        `${focus}:border-muted-foreground ${focus}:bg-background ${focus}:ring-0`,
        '[&_input]:placeholder:text-muted-foreground',
      ].join(' ')
    );
    expect(NAV).not.toMatch(/SIDEBAR_SEARCH_CLASS[\s\S]{0,40}!/);
    expect(NAV).toContain('<Search className="size-3.5 text-muted-foreground opacity-100" />');
  });

  it('collapse / expand all is one toggle over every group, Temporary chats included', () => {
    const toggle = slice(NAV, 'const toggleAllGroups = () => {', '\n  };\n');
    expect(toggle).toContain('const expand = allGroupsCollapsed;');
    expect(toggle).toContain('[UNBOUND_FOLDER_ID, ...folders.map((folder) => folder.projectId)]');
    expect(toggle).not.toContain('visibleFolders');
    expect(NAV).toContain("allGroupsCollapsed ? t('Expand all groups') : t('Collapse all groups')");
    expect(NAV).toContain('aria-label={toggleAllLabel}');
    expect(NAV).toContain('title={toggleAllLabel}');
    expect(NAV).toContain('<ChevronsUpDown className="size-4" />');
    expect(NAV).toContain('<ChevronsDownUp className="size-4" />');
    // Its state reads the stored folds of the groups the list shows without a
    // search, so typing one cannot change its label.
    expect(NAV).toContain(
      'toggleGroupIds.length > 0 && toggleGroupIds.every((id) => !isProjectExpanded(id))'
    );
    expect(NAV).not.toContain('visibleGroupIds');
  });

  it('a search opens every group with matches, leaves the folds stored, and disables the toggle', () => {
    expect(NAV).toContain(
      'const groupExpanded = (groupId: string) => queryActive || isProjectExpanded(groupId);'
    );
    expect(TEMPORARY_GROUP).toContain('const expanded = groupExpanded(UNBOUND_FOLDER_ID);');
    expect(REPOSITORY_GROUP).toContain('const expanded = groupExpanded(folder.projectId);');
    // The header writes nothing while a search is typed.
    expect(TEMPORARY_GROUP).toContain('onToggle: queryActive');
    expect(REPOSITORY_GROUP).toContain('onToggle: queryActive');
    expect(NAV).toContain('disabled={queryActive || toggleGroupIds.length === 0}');
  });

  it('clearing a search leaves exactly the last query s groups open (user ruling)', () => {
    const handler = slice(NAV, 'const handleQueryChange = (next: string) => {', '\n  };\n');
    // Only on the step from a non-empty query to an empty one...
    expect(handler).toContain('if (queryActive && next.trim().length === 0) {');
    // ...and only the groups the current (last non-empty) query shows.
    expect(handler).toContain('...(unboundFolder ? [UNBOUND_FOLDER_ID] : []),');
    expect(handler).toContain('visibleFolders.map((folder) => folder.projectId)');
    expect(handler).toContain('matched.map((id) => [id, true])');
    expect(handler).toContain('...prev,');
    expect(NAV).toContain('onChange={(event) => handleQueryChange(event.target.value)}');
    expect(NAV.split('setQuery(').length - 1).toBe(1);
  });

  it('28px icon buttons, and selection mode swaps the row in place', () => {
    expect(constant('TOOL_BUTTON_CLASS')).toBe('size-7 shrink-0 text-muted-foreground sm:size-7');
    expect(NAV).toContain('<div className={TOP_ZONE_END_CLASS}>');
    expect(NAV).toContain('<div className="flex h-7 items-center gap-0.5">');
    expect(NAV).toContain("{t('{{count}} selected', { count: selection.size })}");
  });
});

describe('the account footer (decision 183, user ruling 2026-10-12, prototype v6 `.foot.proto`)', () => {
  it('is the prototype s 32px row in every sign-in state', () => {
    expect(FOOTER).toContain(
      "'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left',"
    );
    expect(FOOTER).toContain("'text-muted-foreground hover:bg-hover',");
    // One trigger, its content switching by state: the height is the trigger's.
    expect(FOOTER.split('<PopoverTrigger').length - 1).toBe(1);
    expect(FOOTER).not.toMatch(/\bh-6\b/);
    expect(FOOTER).not.toMatch(/\brounded-(md|lg)\b/);
  });

  it('a 22px avatar on --selection with a semibold 14px initial, the e-mail in the soft ink', () => {
    expect(FOOTER).toContain('<Avatar className="size-5.5 shrink-0 bg-transparent">');
    // text-meta, not the prototype's 12px: the initial can be CJK (≥14px).
    expect(FOOTER).toContain(
      '<AvatarFallback className="bg-selection font-semibold text-foreground text-meta">'
    );
    expect(FOOTER).not.toContain('className="size-4 shrink-0');
    expect(FOOTER).toContain('className="min-w-0 flex-1 truncate text-meta text-foreground-soft"');
    expect(FOOTER).toContain(
      '<ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />'
    );
  });

  it('shows no spend: today s cost is gone from the footer (the account card keeps usage)', () => {
    for (const gone of ['useUsageStats', 'todayCost', 'formatCostUsd', 'tabular-nums', '$']) {
      expect(FOOTER, gone).not.toContain(gone);
    }
    expect(FOOTER).toContain('<UserProfileCard');
    const card = code(join(COMPONENTS, 'user/UserProfileCard.tsx'));
    expect(card).toContain('useUsageStats(');
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
    // One row renderer for every list.
    expect(NAV.split('place={placeOf(row)}').length - 1).toBe(1);
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
    // LeftNav names its classes in a constant (decision 183's prototype look,
    // which hides the group's `::before` hairline altogether).
    const group = file.endsWith('LeftNav.tsx')
      ? constant('SIDEBAR_SEARCH_CLASS')
      : slice(source, '<InputGroup ', '>');
    expect(group).toContain('h-7');
    expect(group).toContain('rounded-sm');
    expect(group).toMatch(/before:(hidden|rounded-\[calc\(var\(--radius-sm\)-1px\)\])/);
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
