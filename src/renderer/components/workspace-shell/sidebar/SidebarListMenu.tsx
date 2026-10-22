/**
 * Layout 5b (ruling L2): the list's one menu — how the chats are grouped, and
 * the list tools the old tool row held (filter, fold all, select to archive,
 * new group). Opened from the small icon a group heading shows on hover, as in
 * the official app; the grouping radio is also a submenu of the list's
 * right-click, so it stays reachable when no heading is on screen.
 */
import { ChevronsDownUp, ChevronsUpDown, ListChecks, ListFilter, Plus, Search } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SIDEBAR_ARCHIVE_MODES, type SidebarArchiveMode } from '@/stores/sidebarArchive';

/** Dictionary keys, in the menu's order (default first). */
export const SIDEBAR_GROUPING_LABELS: Readonly<Record<SidebarArchiveMode, string>> = {
  workspace: 'By repository',
  group: 'By my groups',
  status: 'By status',
  date: 'By date',
};

export function GroupingModeRadio({
  mode,
  onModeChange,
}: {
  mode: SidebarArchiveMode;
  onModeChange: (mode: SidebarArchiveMode) => void;
}) {
  const { t } = useI18n();
  return (
    <MenuRadioGroup
      value={mode}
      onValueChange={(value) => {
        if ((SIDEBAR_ARCHIVE_MODES as readonly unknown[]).includes(value)) {
          onModeChange(value as SidebarArchiveMode);
        }
      }}
    >
      {SIDEBAR_ARCHIVE_MODES.map((option) => (
        <MenuRadioItem key={option} value={option}>
          {t(SIDEBAR_GROUPING_LABELS[option])}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

export interface SidebarListMenuProps {
  mode: SidebarArchiveMode;
  onModeChange: (mode: SidebarArchiveMode) => void;
  onFilter: () => void;
  foldAll: { label: string; collapsed: boolean; disabled: boolean; onToggle: () => void };
  onSelectToArchive: () => void;
  /** 「按分组」 only. */
  onNewGroup?: () => void;
  /** The heading's hover class (`GROUP_ACTION_CLASS`), so it shows with its siblings. */
  className?: string;
}

export function SidebarListMenu({
  mode,
  onModeChange,
  onFilter,
  foldAll,
  onSelectToArchive,
  onNewGroup,
  className,
}: SidebarListMenuProps) {
  const { t } = useI18n();
  const label = t('Group and filter chats');
  // 「筛选对话」 hands focus to the field it opens; the menu must not take it
  // back to its trigger as it closes.
  const returnFocusRef = useRef(true);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(className, 'data-popup-open:opacity-100')}
            aria-label={label}
            title={label}
          />
        }
      >
        <ListFilter className="size-3.5" />
      </MenuTrigger>
      <MenuPopup
        align="end"
        className="min-w-44"
        finalFocus={() => {
          const returnFocus = returnFocusRef.current;
          returnFocusRef.current = true;
          return returnFocus;
        }}
      >
        <MenuGroup>
          <MenuGroupLabel>{t('Group chats')}</MenuGroupLabel>
          <GroupingModeRadio mode={mode} onModeChange={onModeChange} />
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            returnFocusRef.current = false;
            onFilter();
          }}
        >
          <Search />
          {t('Filter chats')}
        </MenuItem>
        <MenuItem disabled={foldAll.disabled} onClick={foldAll.onToggle}>
          {foldAll.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
          {foldAll.label}
        </MenuItem>
        <MenuItem onClick={onSelectToArchive}>
          <ListChecks />
          {t('Select sessions to archive')}
        </MenuItem>
        {onNewGroup && (
          <MenuItem onClick={onNewGroup}>
            <Plus />
            {t('New group…')}
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
