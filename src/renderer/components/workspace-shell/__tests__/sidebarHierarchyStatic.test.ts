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
 *   top nav       13px 400 foreground-soft  h-7   16px icon; hover fill-ghost-hover
 *   filter        search (h-8), shown only while asked for (layout 5b)
 *   group label   12px 500 faint            h-7   no icon, no hover fill; soft ink on hover
 *   chat          13px 400 foreground-soft  h-7   text only, a trailing state mark
 *   auxiliary     12px 400 faint            h-7   「显示更多」 in the title column
 *
 * Layout 5b (ui-cohesion §6, the Claude Code desktop screenshot) replaced the
 * two-entry nav and the tool row with four entries and the list menu, and
 * moved the row's state mark to its end.
 *
 * Decision 188 (2026-10-13, screenshot-style spacing preview): every row 32px
 * and wider gaps between the three zones. Design system v2 (§3.1, §7.12):
 * rows and nav `text-ui` (13px), the group label `text-small` / 500 / faint,
 * rows frameless with an inset `rounded-xs` ghost highlight.
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
const LIST_MENU = code(join(SHELL, 'sidebar/SidebarListMenu.tsx'));

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

describe('weights (design system v2 §3.2)', () => {
  it('500 only on the group label (and its inline editors); no 500 on the dock or the bar title', () => {
    // Design system v2 §7.12: the group label is the sidebar's one 500 text
    // (Microsoft YaHei UI renders it as 400, so it must never be the only
    // carrier of a level: the faint ink carries it too). The two inline name
    // editors take the label's look so the text does not jump.
    expect(NAV.match(/font-medium/g)).toHaveLength(3);
    expect(GROUP_HEADER).toContain('font-medium text-foreground-faint');
    expect(DOCK).not.toContain('font-semibold');
    expect(BAR).not.toContain('font-medium');
  });

  it('the title bar title is 13px (text-ui) / 400 (design system v2 / layout 5a)', () => {
    expect(BAR).toContain("const titleClass = 'min-w-0 truncate text-ui text-foreground';");
  });

  it('no level of the chat sidebar is bold any more: group labels are the grey 400 label', () => {
    expect(NAV).not.toContain('font-semibold');
  });
});

describe('the panel title is gone from all five panels (decision 183 §1.9)', () => {
  it('LeftDock renders no DockTitle, and names itself through its region', () => {
    expect(DOCK).not.toContain('DockTitle');
    expect(DOCK).not.toContain('text-section');
    expect(DOCK).not.toContain('border-b px-3');
    // §2.7 / layout 5a: one region now, the sidebar, named for screen readers.
    expect(DOCK).toContain("aria-label={t('Primary navigation')}");
  });
});

describe('levels (decision 183, prototype `.vA`)', () => {
  it('top nav (layout 5b): four h-7 entries, text-ui, a 16px icon, frameless ghost hover', () => {
    expect(constant('NAV_ITEM_CLASS')).toBe(
      'flex h-7 w-full items-center gap-2 rounded-xs px-2 text-left text-ui text-foreground-soft hover:bg-fill-ghost-hover hover:text-foreground focus-visible:bg-fill-ghost-hover disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-fill-ghost-hover'
    );
    expect(constant('NAV_ICON_CLASS')).toBe('size-4 shrink-0 text-muted-foreground');
    // 新对话, 搜索, 技能与插件, and 仓库's menu trigger.
    expect(NAV.split('className={NAV_ITEM_CLASS}').length - 1).toBe(4);
    expect(NAV.split('className={NAV_ICON_CLASS}').length - 1).toBe(4);
    const nav = slice(NAV, "{t('New chat')}</span>", "{t('Skills')}");
    expect(nav.indexOf("{t('Search')}")).toBeLessThan(nav.indexOf("{t('Repositories')}"));
    // New chat opens the home page (decision 174); the old disc is gone.
    expect(NAV).toContain('onClick={handleNewSession}');
    expect(NAV).not.toContain('rounded-full bg-fill-ghost-selected');
    // Search: the shell's global search, the shortcut faint at the right.
    expect(NAV).toContain('onClick={() => search?.onOpen()}');
    expect(NAV).toContain(
      '<span className="shrink-0 text-2xs text-foreground-faint">{search.shortcut}</span>'
    );
    // Repositories: each one's actions, then Add repository (the dialog).
    expect(nav).toContain('{repositoryMenuItems(repo)}');
    expect(nav).toContain('onClick={() => onAddRepository?.()}');
    // Skills and plugins: the Extensions settings page.
    expect(NAV).toContain("requestSettings('extensions')");
  });

  it('group label: 12px / 500 / faint, soft ink on hover, no icon, no hover fill', () => {
    expect(GROUP_HEADER).toContain(
      "'group flex h-7 w-full items-center gap-1 rounded-xs px-2 has-focus-visible:bg-fill-ghost-hover',"
    );
    // Issue #26 item 7: the clay drop ring while a chat is dragged over it.
    expect(GROUP_HEADER).toContain("drop?.active && 'ring-2 ring-primary/60 ring-inset'");
    expect(GROUP_HEADER).toContain(
      'className="flex min-w-0 flex-1 items-center gap-1 text-left text-small font-medium text-foreground-faint group-hover:text-foreground-soft group-has-focus-visible:text-foreground-soft"'
    );
    expect(GROUP_HEADER).toContain('aria-expanded={expanded}');
    expect(GROUP_HEADER).not.toContain('hover:bg-fill-ghost-hover');
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
    // Layout 5b: so does the list menu, shown with them on every heading.
    expect(LIST_MENU).toContain("className={cn(className, 'data-popup-open:opacity-100')}");
    expect(NAV).toContain(
      'const listMenu = <SidebarListMenu {...listMenuProps} className={GROUP_ACTION_CLASS} />;'
    );
    for (const group of [TEMPORARY_GROUP, REPOSITORY_GROUP]) expect(group).toContain('{listMenu}');
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
    // Design system v2 §6: the run marks are StatusIcon's.
    expect(GROUP_SUMMARY).toContain('<StatusIcon status="running" label={runningLabel} />');
    expect(GROUP_SUMMARY).toContain('{summary.running > 1 && summary.running}');
    expect(GROUP_SUMMARY).toContain('status="waiting"');
    expect(GROUP_SUMMARY).toContain(
      "summary.unread === 'failed' ? 'bg-destructive' : 'bg-success'"
    );
    expect(NAV).toContain('summary: deriveGroupSummary(folder.rows, unreadSessionIds)');
    expect(NAV).toContain('summary: deriveGroupSummary(unboundFolder.rows, unreadSessionIds)');
  });

  it('chat: text-ui / 400 in --foreground-soft; the open one keeps the body colour', () => {
    expect(ROW).toContain(
      "'group relative flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-xs px-2 text-left text-ui',"
    );
    expect(ROW).toContain("? 'bg-fill-ghost-selected text-foreground'");
    expect(ROW).toContain(
      ": 'text-foreground-soft hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover'"
    );
    // The token is alpha-free and takes no /N (design system, Alpha discipline).
    expect(NAV).not.toMatch(/text-foreground-soft\/\d/);
    expect(NAV).not.toMatch(/muted-foreground-faint\/\d/);
    // The rename editor that replaces the row keeps its size.
    expect(ROW).toContain(
      'className="h-6 flex-1 rounded-sm text-ui before:rounded-[calc(var(--radius-sm)-1px)]"'
    );
  });

  it('layout 5b: one trailing state mark, by urgency; started is the faint filled dot (issue #16)', () => {
    const mark = slice(
      ROW,
      '{!onToggleSelect &&\n            (rowWaiting ? (',
      '{!onToggleSelect && ('
    );
    // After the title and the context text: the mark trails.
    expect(ROW.indexOf('{titleParts.suffix === null')).toBeLessThan(ROW.indexOf('(rowWaiting ? ('));
    expect(ROW.indexOf('{branch && (')).toBeLessThan(ROW.indexOf('(rowWaiting ? ('));
    // Urgency order: waiting-on-you, running, failed, unread result, attached.
    const order = [
      '<StatusIcon status="waiting"',
      '<StatusIcon status="running"',
      ') : row.failed ? (',
      ') : unread ? (',
      ') : started ? (',
      ') : null)}',
    ].map((needle) => mark.indexOf(needle));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A failure is the warning icon; red only while unseen.
    expect(mark).toContain("unread ? 'text-destructive' : 'text-muted-foreground'");
    // Issue #16: attached is FILLED (no ring); a chat not started has no mark.
    expect(mark).toContain('<span className="size-1.5 rounded-full bg-muted-foreground-faint" />');
    expect(ROW).not.toContain("title={t('Not started')}");
    // A pending approval waits on the user too; its count is the mark's words.
    expect(ROW).toContain(
      '(row.busy && isWaitingSessionStatus(row.status)) || pendingApprovalCount > 0'
    );
    expect(ROW).toContain(
      "t('{{count}} pending approval requests', { count: pendingApprovalCount })"
    );
  });

  it('auxiliary (layout 5b): h-7, 12px faint, the text in the title column', () => {
    expect(AUX_ROW).toContain(
      'className="flex h-7 w-full items-center rounded-xs px-2 text-small text-foreground-faint tabular-nums hover:bg-fill-ghost-hover hover:text-muted-foreground focus-visible:bg-fill-ghost-hover"'
    );
    // Rows have no leading slot, so neither does this.
    expect(AUX_ROW).not.toContain('w-4');
    // §1.5: no 「新建对话」 row in an empty group, so no icon slot content.
    expect(AUX_ROW).not.toContain('icon');
    expect(NAV).not.toContain('icon={<Plus');
    // 「显示更多」, its count the tooltip.
    expect(NAV).toContain("title={t('View more ({{count}})', { count: limited.hiddenCount })}");
    expect(NAV).toContain("{t('Show more chats')}");
  });

  it('the 12px group label sits one tier below the 13px rows (issue #14, design system v2)', () => {
    // Design system v2 §3.1: only v2 tiers -- no Tailwind defaults, no legacy aliases.
    expect(NAV).not.toMatch(/\btext-(xs|sm|base|lg|meta|section|group-label)\b/);
    // Decision 186 (issue #14): the group label reads lighter than the chats
    // it heads. Design system v2: rows and the top nav are `text-ui` (13px),
    // the label `text-small` (12px), 500, faint. Decision 187's inline name
    // editors (new group and rename) take the label's size.
    expect(GROUP_HEADER).toContain('text-small font-medium');
    expect(NAV.match(/text-small font-medium/g)).toHaveLength(3);
    // `Button size="xs"` is 12px (`text-small`); buttons are `text-ui` in v2,
    // so every one here overrides it.
    const xsButtons = [...NAV.matchAll(/<Button[^>]*size="xs"[^>]*>/g)].map((match) => match[0]);
    // Layout 5b: the empty-state 「添加仓库」 became a plain sidebar row, not a Button.
    expect(xsButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of xsButtons) expect(button).toContain('text-ui');
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

  it('the repositories (or the add-repository card) first, Temporary chats last', () => {
    const temporary = LIST_AREA.indexOf('{renderTemporaryGroup()}');
    const repositories = LIST_AREA.indexOf('visibleFolders.map(renderRepositoryGroup)');
    const card = LIST_AREA.indexOf('<Empty ');
    expect(temporary).toBeGreaterThan(-1);
    // Issue #13 (decision 186): reversed from decision 183 §1.2, which pinned
    // it above the repositories.
    expect(repositories).toBeLessThan(temporary);
    expect(card).toBeLessThan(temporary);
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
      'max-h-[',
      'sticky',
      'isolate',
    ]) {
      expect(NAV, gone).not.toContain(gone);
    }
    // Layout 5b: 「仓库」 is a nav entry above the list, not a region title in it.
    expect(NAV.split("t('Repositories')").length - 1).toBe(1);
    expect(
      slice(
        NAV,
        '<MenuTrigger render={<button type="button" className={NAV_ITEM_CLASS} />}>',
        '</MenuTrigger>'
      )
    ).toContain("t('Repositories')");
    // Groups and rows are separated by spacing alone, and (layout 5b) the top
    // zone's hairline went with the tool row: the panel body has no line.
    expect(NAV).not.toMatch(/\bborder-t\b/);
    expect(NAV).not.toMatch(/\bborder-b\b/);
  });

  it('one full-width zone line, the account footer`s (layout 5b; was two, user ruling 2026-10-12)', () => {
    // The top zone's line went with the tool row (the screenshot's list runs
    // straight on from the nav). The footer's is its own top border, across
    // the panel; layout 5b: 6px above and below the row.
    expect(NAV).not.toContain('TOP_ZONE_END_CLASS');
    expect(FOOTER).toContain(
      '<div className="flex shrink-0 items-center gap-0.5 border-t border-border-soft px-2 py-1.5">'
    );
  });

  it('spacing (layout 5b): the list starts under the nav, groups 16px apart, rows flush, no indent', () => {
    // Decision 188's pt-1 measured from the tool row's hairline, which is
    // gone: the nav's pb-2 plus the first group's mt-1 is the gap now.
    expect(LIST_AREA).toContain('className="px-2 pt-0 pb-3"');
    expect(NAV).toContain('<div className="flex shrink-0 flex-col gap-px px-2 pb-2">');
    expect(constant('SIDEBAR_GROUP_CLASS')).toBe('mt-4 first:mt-1');
    expect(constant('GROUP_ROWS_CLASS')).toBe('flex flex-col');
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
    // Folded, `limitFolderRows` keeps only the selected chat (user, 2026-10-23).
    expect(REPOSITORY_GROUP).toContain('{limited.rows.length > 0 && (');
    expect(NAV).not.toContain('folder.rows.length === 0 &&');
  });
});

describe('the list tools (layout 5b; were the tool row, decision 183 §1.8, §2.1)', () => {
  it('the filter field shows while asked for or while it holds a query, and owns Escape', () => {
    expect(NAV).toContain(') : filterOpen || queryActive ? (');
    expect(NAV).toContain('<div className="shrink-0 px-2 pb-1" {...FILTER_HOLDS_ESCAPE}>');
    expect(NAV).toContain('<InputGroup className={SIDEBAR_SEARCH_CLASS}>');
    // Opened from the list menu, or by typing on the list.
    expect(LIST_MENU).toContain("{t('Filter chats')}");
    expect(NAV).toContain('handleQueryChange(query + event.key);');
  });

  it('the search box is drawn like the prototype, overriding the primitive by matching stacks', () => {
    // User ruling 2026-10-11: prototype `.search`, not InputGroup's default;
    // design system v2 §7.12 makes it a filled field (no line until focus).
    // Each override repeats the variant stack of the base class it replaces,
    // so tailwind-merge drops the base one (the rendered result is asserted in
    // sidebarActiveAndFolders.test.ts). No `!important`.
    const focus = 'has-[input:focus-visible,textarea:focus-visible]';
    expect(constant('SIDEBAR_SEARCH_CLASS')).toBe(
      [
        'h-8 min-w-0 flex-1 rounded-sm border-transparent bg-fill-neutral shadow-none before:hidden dark:bg-fill-neutral',
        `${focus}:border-border-strong ${focus}:ring-0`,
        '[&_input]:placeholder:text-muted-foreground',
      ].join(' ')
    );
    expect(NAV).not.toMatch(/SIDEBAR_SEARCH_CLASS[\s\S]{0,40}!/);
    expect(NAV).toContain('<Search className="size-3.5 text-muted-foreground opacity-100" />');
  });

  it('collapse / expand all is one toggle over every group, Temporary chats included', () => {
    const toggle = slice(NAV, 'const toggleAllGroups = () => {', '\n  };\n');
    expect(toggle).toContain('const expand = allGroupsCollapsed;');
    // Issue #15: the ids are the same set, computed once into `toggleGroupIds`
    // so 「按分组」 mode (the user's groups plus 「未分组」) does not need a second
    // copy of this logic.
    expect(toggle).toContain('Object.fromEntries(toggleGroupIds.map((id) => [id, expand]))');
    expect(NAV).toContain(`  const toggleGroupIds = groupingByGroup
    ? groupFolderIds
    : groupingDerived
      ? bucketFolders.map((folder) => folder.projectId)
      : [`);
    expect(toggle).not.toContain('visibleFolders');
    expect(NAV).toContain("allGroupsCollapsed ? t('Expand all groups') : t('Collapse all groups')");
    // Layout 5b: an item of the list menu, labelled by the same text.
    expect(NAV).toContain('label: toggleAllLabel,');
    expect(LIST_MENU).toContain('{foldAll.label}');
    expect(LIST_MENU).toContain('{foldAll.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}');
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
    expect(NAV).toContain('disabled: queryActive || toggleGroupIds.length === 0,');
    expect(LIST_MENU).toContain('disabled={foldAll.disabled}');
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

  it('selection mode swaps its bar in where the filter field goes', () => {
    expect(NAV).not.toContain('TOOL_BUTTON_CLASS');
    expect(NAV).toContain('<div className="flex h-8 shrink-0 items-center gap-0.5 px-2">');
    expect(NAV).toContain("{t('{{count}} selected', { count: selection.size })}");
    expect(LIST_MENU).toContain("{t('Select sessions to archive')}");
  });
});

describe('the account footer (decision 183, user ruling 2026-10-12, prototype v6 `.foot.proto`)', () => {
  it('is the prototype s 32px row in every sign-in state', () => {
    expect(FOOTER).toContain(
      "'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-xs px-1.5 text-left',"
    );
    expect(FOOTER).toContain("'text-muted-foreground hover:bg-fill-ghost-hover',");
    // One trigger, its content switching by state: the height is the trigger's.
    expect(FOOTER.split('<PopoverTrigger').length - 1).toBe(1);
    expect(FOOTER).not.toMatch(/\bh-6\b/);
    expect(FOOTER).not.toMatch(/\brounded-(md|lg)\b/);
  });

  it('a 22px avatar on --selection with a semibold 14px initial, the e-mail in the soft ink', () => {
    expect(FOOTER).toContain('<Avatar className="size-5.5 shrink-0 bg-transparent">');
    // text-small (12px): the initial can be CJK, and 12px is v2's CJK floor.
    expect(FOOTER).toContain(
      '<AvatarFallback className="bg-fill-ghost-selected font-semibold text-foreground text-small">'
    );
    expect(FOOTER).not.toContain('className="size-4 shrink-0');
    // The e-mail at the sidebar rows' size (design system v2: text-ui).
    expect(FOOTER).toContain('className="min-w-0 flex-1 truncate text-ui text-foreground-soft"');
    // Layout 5b: the screenshot's quiet ⌄ after the name.
    expect(FOOTER).toContain(
      '<ChevronDown aria-hidden className="ml-auto size-3.5 shrink-0 text-foreground-faint" />'
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
    expect(ROW).toContain(
      ": 'text-foreground-soft hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover'"
    );
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
    join(COMPONENTS, 'source-control/BranchSwitcher.tsx'),
  ];

  it.each(SEARCH_FIELDS)('%s puts InputGroupInput before InputGroupAddon', (file) => {
    const source = code(file);
    const input = source.indexOf('<InputGroupInput');
    const addon = source.indexOf('<InputGroupAddon align="inline-start">');
    expect(input).toBeGreaterThan(-1);
    expect(addon).toBeGreaterThan(input);
    // LeftNav names its classes in a constant (decision 183's prototype look,
    // which hides the group's `::before` hairline altogether), and since
    // decision 188 is 32px tall like the sidebar's rows; the other two stay h-7.
    const isLeftNav = file.endsWith('LeftNav.tsx');
    const group = isLeftNav ? constant('SIDEBAR_SEARCH_CLASS') : slice(source, '<InputGroup ', '>');
    expect(group).toContain(isLeftNav ? 'h-8' : 'h-7');
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

/**
 * Design system v2 §1 rule 1: the model menu's search field sits INSIDE the
 * menu's frame, so it has no frame of its own -- a plain row with a hairline
 * under it. Decision 167's hazard (an absolutely positioned icon painted over
 * by the input's opaque wrapper) cannot happen in a flex row; the icon still
 * comes after the input in source and is drawn first with `order-first`.
 */
describe('model menu search: a frameless flex row, input first', () => {
  const source = code(join(COMPONENTS, 'chat/ComposerModelTrigger.tsx'));

  it('the input precedes the icon, which is drawn first in a flex row', () => {
    const input = source.indexOf('<Input');
    const icon = source.indexOf('<Search className="order-first');
    expect(input).toBeGreaterThan(-1);
    expect(icon).toBeGreaterThan(input);
    expect(source).toContain('flex h-8 items-center gap-1.5 border-border-soft border-b');
  });
});
