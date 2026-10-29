/**
 * dsh-rebase P1-16e (decision 104 rule 1) — the permanent home of the
 * legacy-asset notice, in Settings → Extensions.
 *
 * The startup dialog (`LegacyAssetNoticePrompt`) opens once; this section is
 * where the same list can be read again at any time. It asks Main afresh on
 * every visit, so a file the user has since moved or rewritten drops off.
 *
 * It takes no room unless something was found: then it is one folded row
 * with the count, and the list opens below it.
 */

import { type LegacyAssetNoticeState, legacyAssetCount } from '@shared/legacyAssets';
import { ChevronRight, FolderOpen, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { LegacyAssetList, openLegacyAgentFolder } from './LegacyAssetNotice';
import { SETTINGS_CARD_FRAME_CLASS, SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function LegacyAssetsSettings({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<LegacyAssetNoticeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    window.electronAPI.legacyAssets.inspect(repoPath ? { cwd: repoPath } : {}).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const count = state ? legacyAssetCount(state.report) : 0;

  if (error) {
    return (
      <SettingsSectionBlock bare title={t('Items from the previous version')}>
        <Alert variant="error">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </SettingsSectionBlock>
    );
  }
  // Nothing left over (or still checking): the section does not take up the page.
  if (!state || count === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={SETTINGS_CARD_FRAME_CLASS}
      data-legacy-assets=""
    >
      <CollapsibleTrigger className="flex min-h-10 w-full min-w-0 items-center gap-2 px-4 py-2.5 text-left hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover">
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
        <span className="shrink-0 text-ui font-semibold">
          {t('Items from the previous version: {{count}}', { count })}
        </span>
        <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">
          {t('No longer loaded. Listed only, nothing is changed.')}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-4 px-4 pt-1 pb-4">
          <LegacyAssetList report={state.report} />
          <p className="text-small text-muted-foreground">
            {state.report.workspace
              ? t('Project files were checked in {{path}}.', { path: state.report.workspace })
              : t('Open a workspace to also check its project files.')}
          </p>
          {/* `normal-case`: the Chinese label holds the word "Agent", which the
              button base would lowercase (decision 144, problem 35). */}
          <Button
            variant="outline"
            className="w-fit normal-case"
            onClick={() => void openLegacyAgentFolder().then(setOpenError)}
          >
            <FolderOpen className="h-4 w-4" />
            {t('Open agent folder')}
          </Button>
          {openError && <p className="text-small text-destructive">{openError}</p>}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
