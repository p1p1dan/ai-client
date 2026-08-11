import { ChevronDown, Folder, Search } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
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
import type { FolderMenuEntry, FolderMenuModel } from './composerTarget';
import { targetTriggerClass } from './middleColumnLayout';

interface FolderComboItem {
  id: string;
  label: string;
  value: string;
}

interface FolderComboGroup {
  value: string;
  label: string;
  items: FolderComboItem[];
}

// Round-3 fix (point-check #8): folder items carry folder identity only —
// no branch/secondary text (that domain moved entirely to
// TargetBranchSelect / buildBranchMenu).
function toComboItem(entry: FolderMenuEntry): FolderComboItem {
  return {
    id: entry.workspaceId,
    label: entry.label,
    value: entry.workspaceId,
  };
}

interface TargetFolderSelectProps {
  folderMenu: FolderMenuModel;
  activeWorkspaceId: string | null;
  /** Trigger label — the current target's project name. */
  currentLabel: string;
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
  /** Opens the shared AddRepositoryDialog; footer actions don't render without it (no dead buttons). */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
  /**
   * New Folder footer action. `undefined` when the `temporaryWorkspaceEnabled`
   * setting is off (parity with the legacy shells' Temp gating) — the footer
   * entry is not rendered in that case.
   */
  onCreateTempTarget?: () => Promise<void>;
}

/**
 * Folder target dropdown (T-27), including the footer actions
 * (Use Existing…/Clone…/Add Remote…/New Folder) added in batch 3.
 */
export function TargetFolderSelect({
  folderMenu,
  activeWorkspaceId,
  currentLabel,
  workspacePath,
  disabled,
  disabledReason,
  onSelect,
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
  const lastGroupValue = groups.at(-1)?.value;

  return (
    <Combobox<string>
      items={groups}
      value={activeWorkspaceId}
      onValueChange={(value) => {
        if (value) onSelect(value);
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
        // the target's full path (see `workspacePath`).
        title={disabled ? disabledReason : (workspacePath ?? undefined)}
        render={<button type="button" className={targetTriggerClass()} />}
      >
        <Folder className="size-3.5 shrink-0 text-folder" />
        <span className="max-w-40 truncate text-foreground">{currentLabel}</span>
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
        <ComboboxEmpty>{t('No folders found')}</ComboboxEmpty>
        <ComboboxList>
          {(group: FolderComboGroup) => (
            <Fragment key={group.value}>
              <ComboboxGroup items={group.items}>
                <ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>
                <ComboboxCollection>
                  {(item: FolderComboItem) => (
                    <ComboboxItem key={item.id} value={item.value}>
                      <span className="flex min-w-0 items-center gap-2">
                        <Folder className="size-3.5 shrink-0 text-folder" />
                        <span className="truncate">{item.label}</span>
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
              {group.value !== lastGroupValue && <ComboboxSeparator />}
            </Fragment>
          )}
        </ComboboxList>
        {onAddRepository && (
          <div className="border-t p-1">
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ui hover:bg-hover"
              onClick={() => {
                setOpen(false);
                onAddRepository('local');
              }}
            >
              {t('Use Existing…')}
            </button>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ui hover:bg-hover"
              onClick={() => {
                setOpen(false);
                onAddRepository('remote');
              }}
            >
              {t('Clone…')}
            </button>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ui hover:bg-hover"
              onClick={() => {
                setOpen(false);
                onAddRepository('ssh');
              }}
            >
              {t('Add Remote…')}
            </button>
            {onCreateTempTarget && (
              <button
                type="button"
                className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ui hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  void onCreateTempTarget();
                }}
              >
                <span className="flex-1 truncate text-left">{t('New Folder')}</span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {t('Temporary workspace')}
                </span>
              </button>
            )}
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
