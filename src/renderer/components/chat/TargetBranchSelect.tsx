import { ChevronDown, GitBranch, Search } from 'lucide-react';
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
import { CreateWorktreeDialog } from '@/components/worktree/CreateWorktreeDialog';
import { useGitBranches } from '@/hooks/useGit';
import { useWorktreeCreate } from '@/hooks/useWorktree';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { BranchMenuEntry, BranchMenuModel } from './composerTarget';
import { targetTriggerClass } from './middleColumnLayout';

interface BranchComboItem {
  id: string;
  label: string;
  value: string;
  path: string;
}

interface BranchComboGroup {
  value: string;
  /** Empty for the unlabelled `main` group (A07: main is pinned, no header). */
  label: string;
  items: BranchComboItem[];
}

function toComboItem(entry: BranchMenuEntry): BranchComboItem {
  return { id: entry.workspaceId, label: entry.label, value: entry.workspaceId, path: entry.path };
}

interface TargetBranchSelectProps {
  branchMenu: BranchMenuModel;
  activeWorkspaceId: string | null;
  /** Trigger label — the current target's branch/worktree name. */
  currentLabel: string;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (workspaceId: string) => void;
  /** workdir for the controlled CreateWorktreeDialog (project's main/remote workspace path). */
  worktreeRepoPath: string | null;
  /** projectName for the controlled CreateWorktreeDialog. */
  worktreeProjectName: string;
  /** Waits for the new worktree's path to land in the tree, then auto-switches to it. */
  awaitWorkspaceAtPath: (path: string) => void;
}

/**
 * Branch/worktree target dropdown (T-27), including the `New worktree…`
 * footer action, the "no match" create-worktree empty-state row, and the
 * controlled CreateWorktreeDialog wiring added in batch 3.
 */
export function TargetBranchSelect({
  branchMenu,
  activeWorkspaceId,
  currentLabel,
  disabled,
  disabledReason,
  onSelect,
  worktreeRepoPath,
  worktreeProjectName,
  awaitWorkspaceAtPath,
}: TargetBranchSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) {
      setQuery('');
    }
  }, [open]);

  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktreeInitialBranchName, setWorktreeInitialBranchName] = useState<string | undefined>(
    undefined
  );
  // Only fetches while the CreateWorktreeDialog is open — the branch *menu*
  // above is derived from the store (T-27 decision #5, composerTarget.ts's
  // buildBranchMenu); this is solely the dialog's own base-branch picker.
  const branchesQuery = useGitBranches(worktreeRepoPath, { enabled: worktreeDialogOpen });
  const createWorktree = useWorktreeCreate();

  const openWorktreeDialog = (branchName?: string) => {
    setOpen(false);
    setWorktreeInitialBranchName(branchName);
    setWorktreeDialogOpen(true);
  };

  const groups: BranchComboGroup[] = [];
  if (branchMenu.main) {
    groups.push({ value: 'main', label: '', items: [toComboItem(branchMenu.main)] });
  }
  if (branchMenu.recent.length > 0) {
    groups.push({
      value: 'recent',
      label: t('Recent'),
      items: branchMenu.recent.map(toComboItem),
    });
  }
  if (branchMenu.others.length > 0) {
    groups.push({
      value: 'others',
      label: t('Worktrees'),
      items: branchMenu.others.map(toComboItem),
    });
  }
  const lastGroupValue = groups.at(-1)?.value;
  const trimmedQuery = query.trim();
  const footerButtonClass =
    'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-ui hover:bg-hover';

  return (
    <>
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
          title={disabled ? disabledReason : undefined}
          render={<button type="button" className={targetTriggerClass('muted')} />}
        >
          <GitBranch className="size-3.5 shrink-0" />
          {/* Round-3 fix (point-check #8): this used to cap at max-w-40
              (10rem/160px) to leave room for the folder trigger sharing the
              same target row. Now that the folder dropdown carries no branch
              text (see TargetFolderSelect/buildFolderMenu), the branch
              column no longer needs to budget space for a sibling's content
              — max-w-60 (15rem/240px, token-scale) gives long branch names
              (feature/*, release/*, remotes/origin/*) more room before
              truncating. */}
          <span className="max-w-60 truncate">{currentLabel}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </ComboboxTrigger>
        <ComboboxPopup className="w-80 [&>[data-slot=combobox-popup]]:w-80">
          <div className="border-b p-1">
            <ComboboxInput
              placeholder={t('Search worktrees…')}
              startAddon={<Search />}
              showTrigger={false}
            />
          </div>
          <ComboboxEmpty>
            {trimmedQuery ? (
              <button
                type="button"
                className={cn(footerButtonClass, 'justify-center')}
                onClick={() => openWorktreeDialog(trimmedQuery)}
              >
                {t('New worktree "{{name}}"…', { name: trimmedQuery })}
              </button>
            ) : (
              t('No worktrees found')
            )}
          </ComboboxEmpty>
          <ComboboxList>
            {(group: BranchComboGroup) => (
              <Fragment key={group.value}>
                <ComboboxGroup items={group.items}>
                  {group.label && <ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>}
                  <ComboboxCollection>
                    {(item: BranchComboItem) => (
                      <ComboboxItem
                        key={item.id}
                        value={item.value}
                        // Round-3 fix (point-check #8): widened alongside
                        // the popup/trigger above (max-w-32 -> max-w-48) —
                        // same "no longer shares width with the folder
                        // dropdown" reasoning.
                        endAddon={
                          <span className="max-w-48 truncate font-mono text-code text-muted-foreground">
                            {item.path}
                          </span>
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
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
          <div className="border-t p-1">
            <button
              type="button"
              className={footerButtonClass}
              onClick={() => openWorktreeDialog()}
            >
              {t('New worktree…')}
            </button>
          </div>
        </ComboboxPopup>
      </Combobox>
      <CreateWorktreeDialog
        open={worktreeDialogOpen}
        onOpenChange={setWorktreeDialogOpen}
        branches={branchesQuery.data ?? []}
        isLoading={branchesQuery.isLoading}
        projectName={worktreeProjectName}
        workdir={worktreeRepoPath ?? ''}
        initialBranchName={worktreeInitialBranchName}
        onSubmit={async (options) => {
          await createWorktree.mutateAsync({ workdir: worktreeRepoPath ?? '', options });
          awaitWorkspaceAtPath(options.path);
        }}
      />
    </>
  );
}
