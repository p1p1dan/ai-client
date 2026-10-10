import { ChevronDown, Folder, MessageSquare, Search } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from '@/components/ui/combobox';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { FolderMenuEntry, FolderMenuModel } from './composerTarget';
import { targetTriggerClass } from './middleColumnLayout';

/**
 * What a menu row does when picked. Repositories select their workspace;
 * decision 174 (issue #6, user ruling 2026-10-10) adds 「不选仓库（临时对话）」
 * and turns the old footer buttons into rows of an 「添加仓库」 group, so they
 * are part of the list's keyboard navigation and of its search.
 */
export type FolderMenuAction =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'unbound' }
  | { kind: 'add'; mode: 'local' | 'remote' | 'ssh' }
  | { kind: 'new-temp' };

interface FolderComboItem {
  id: string;
  label: string;
  value: string;
  action: FolderMenuAction;
  /** Muted right-hand text (「新建临时工作区」 after 「新建文件夹」). */
  hint?: string;
}

interface FolderComboGroup {
  value: string;
  /** No label: the group is a single row set apart by its separator. */
  label: string | null;
  items: FolderComboItem[];
}

/** The combobox value of the 「不选仓库（临时对话）」 row (no workspace id looks like this). */
export const UNBOUND_FOLDER_VALUE = 'action:unbound';

// Round-3 fix (point-check #8): folder items carry folder identity only —
// no branch/secondary text (that domain moved entirely to
// TargetBranchSelect / buildBranchMenu).
function toComboItem(entry: FolderMenuEntry): FolderComboItem {
  return {
    id: entry.workspaceId,
    label: entry.label,
    value: entry.workspaceId,
    action: { kind: 'workspace', workspaceId: entry.workspaceId },
  };
}

/**
 * Decision 174: 14px (`text-meta`) and 400 for the group names — coss's own
 * label is 12px / 500, and 「最近」「本机」「远程仓库」「添加仓库」 are CJK,
 * which the design system keeps at 14px or more.
 */
export const FOLDER_MENU_GROUP_LABEL_CLASS = 'text-meta font-normal';

interface TargetFolderSelectProps {
  folderMenu: FolderMenuModel;
  activeWorkspaceId: string | null;
  /**
   * Trigger label — the current target's project name. `null` (decision 174)
   * on the home page with no repository picked or none to pick: the trigger
   * then reads 「未选仓库」 with a muted folder, so there is always a place to
   * pick or add one.
   */
  currentLabel: string | null;
  /**
   * Full filesystem path of the current target, surfaced as the trigger's
   * tooltip.
   *
   * T-30b2 §4.8: the empty-state composer no longer parks a resting
   * `Ready · cwd: /home/…` line inside the card, and that line was the only
   * place the full path was ever printed outside an error state. Removing a
   * display before restoring a route to the same information is how a UI
   * quietly loses facts, so this tooltip is a hard requirement of that change,
   * not a nicety.
   */
  workspacePath?: string | null;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (workspaceId: string) => void;
  /**
   * Decision 174: 「不选仓库（临时对话）」. Offered only where it means
   * something — the home page, whose next conversation can have no repository.
   */
  onSelectUnbound?: () => void;
  /** The 「不选仓库」 row is the current choice (checked). */
  unboundSelected?: boolean;
  /** Opens the shared AddRepositoryDialog; the 「添加仓库」 rows don't render without it (no dead rows). */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
  /**
   * New Folder action. `undefined` when the `temporaryWorkspaceEnabled`
   * setting is off (parity with the legacy shells' Temp gating) — the row is
   * not rendered in that case.
   */
  onCreateTempTarget?: () => Promise<void>;
}

/**
 * Folder target dropdown (T-27). Decision 174 (issue #6, second wave) turned
 * its footer buttons (Use Existing… / Clone… / Add Remote… / New Folder) into
 * rows of an 「添加仓库」 group inside the list — Base UI only navigates and
 * filters rows of its own collection — and added 「不选仓库（临时对话）」 for
 * the home page. With no repository at all the list says 「还没有仓库」;
 * 「未找到文件夹」 is left to a search that matches nothing.
 */
export function TargetFolderSelect({
  folderMenu,
  activeWorkspaceId,
  currentLabel,
  workspacePath,
  disabled,
  disabledReason,
  onSelect,
  onSelectUnbound,
  unboundSelected = false,
  onAddRepository,
  onCreateTempTarget,
}: TargetFolderSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Search text belongs to one open session of the popup — reopening should
  // show the full list again, not a stale filter from last time.
  useEffect(() => {
    if (open) {
      setQuery('');
    }
  }, [open]);

  const groups: FolderComboGroup[] = [];
  if (folderMenu.recents.length > 0) {
    groups.push({
      value: 'recents',
      label: t('Recents'),
      items: folderMenu.recents.map(toComboItem),
    });
  }
  if (folderMenu.local.length > 0) {
    groups.push({
      value: 'local',
      label: t('On This PC'),
      items: folderMenu.local.map(toComboItem),
    });
  }
  if (folderMenu.remote.length > 0) {
    groups.push({
      value: 'remote',
      label: t('Remote repositories'),
      items: folderMenu.remote.map(toComboItem),
    });
  }
  const hasRepositories = groups.length > 0;
  if (onSelectUnbound) {
    groups.push({
      value: 'unbound',
      label: null,
      items: [
        {
          id: UNBOUND_FOLDER_VALUE,
          label: t('No repository (temporary chat)'),
          value: UNBOUND_FOLDER_VALUE,
          action: { kind: 'unbound' },
        },
      ],
    });
  }
  if (onAddRepository) {
    const addItems: FolderComboItem[] = [
      {
        id: 'action:add-local',
        label: t('Use Existing…'),
        value: 'action:add-local',
        action: { kind: 'add', mode: 'local' },
      },
      {
        id: 'action:add-clone',
        label: t('Clone…'),
        value: 'action:add-clone',
        action: { kind: 'add', mode: 'remote' },
      },
      {
        id: 'action:add-ssh',
        label: t('Add Remote…'),
        value: 'action:add-ssh',
        action: { kind: 'add', mode: 'ssh' },
      },
    ];
    if (onCreateTempTarget) {
      addItems.push({
        id: 'action:new-temp',
        label: t('New Folder'),
        value: 'action:new-temp',
        action: { kind: 'new-temp' },
        hint: t('New temporary workspace'),
      });
    }
    groups.push({ value: 'add', label: t('Add Repository'), items: addItems });
  }
  const lastGroupValue = groups.at(-1)?.value;
  const actionByValue = new Map(
    groups.flatMap((group) => group.items.map((item) => [item.value, item.action] as const))
  );

  const runAction = (action: FolderMenuAction) => {
    switch (action.kind) {
      case 'workspace':
        onSelect(action.workspaceId);
        return;
      case 'unbound':
        onSelectUnbound?.();
        return;
      case 'add':
        setOpen(false);
        onAddRepository?.(action.mode);
        return;
      case 'new-temp':
        setOpen(false);
        void onCreateTempTarget?.();
        return;
    }
  };

  const itemIcon = (item: FolderComboItem): ReactNode => {
    if (item.action.kind === 'workspace') {
      return <Folder className="size-3.5 shrink-0 text-folder" />;
    }
    if (item.action.kind === 'unbound') {
      return <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />;
    }
    return null;
  };

  return (
    <Combobox<string>
      items={groups}
      value={unboundSelected ? UNBOUND_FOLDER_VALUE : activeWorkspaceId}
      onValueChange={(value) => {
        const action = value ? actionByValue.get(value) : undefined;
        if (action) runAction(action);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <ComboboxTrigger
        disabled={disabled}
        // A blocked trigger explains itself first; otherwise the tooltip is
        // the target's full path (see `workspacePath`), or — with nothing
        // picked — what the menu is for.
        title={
          disabled
            ? disabledReason
            : currentLabel === null
              ? t('Choose or add a repository')
              : (workspacePath ?? undefined)
        }
        render={<button type="button" className={targetTriggerClass()} />}
      >
        <Folder
          className={cn(
            'size-3.5 shrink-0',
            currentLabel === null ? 'text-muted-foreground' : 'text-folder'
          )}
        />
        <span
          className={cn(
            'max-w-40 truncate',
            currentLabel === null ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {currentLabel ?? t('No repository chosen')}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
      <ComboboxPopup className="w-70 [&>[data-slot=combobox-popup]]:w-70">
        <div className="border-b p-1">
          <ComboboxInput
            placeholder={t('Search folders…')}
            startAddon={<Search />}
            showTrigger={false}
          />
        </div>
        {!hasRepositories && query.trim() === '' && (
          <div className="p-2 text-center text-meta text-muted-foreground">
            {t('No repositories yet')}
          </div>
        )}
        <ComboboxEmpty>{t('No folders found')}</ComboboxEmpty>
        <ComboboxList>
          {(group: FolderComboGroup) => (
            <Fragment key={group.value}>
              <ComboboxGroup items={group.items}>
                {group.label !== null && (
                  <ComboboxGroupLabel className={FOLDER_MENU_GROUP_LABEL_CLASS}>
                    {group.label}
                  </ComboboxGroupLabel>
                )}
                <ComboboxCollection>
                  {(item: FolderComboItem) => (
                    <ComboboxItem key={item.id} value={item.value}>
                      <span className="flex min-w-0 items-center gap-2">
                        {itemIcon(item)}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint && (
                          <span className="shrink-0 text-meta text-muted-foreground">
                            {item.hint}
                          </span>
                        )}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
              {group.value !== lastGroupValue && <ComboboxSeparator />}
            </Fragment>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
