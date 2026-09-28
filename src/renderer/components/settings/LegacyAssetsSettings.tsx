/**
 * dsh-rebase P1-16e (decision 104 rule 1) — the permanent home of the
 * legacy-asset notice, in Settings → Extensions.
 *
 * The startup dialog (`LegacyAssetNoticePrompt`) opens once; this section is
 * where the same list can be read again at any time. It asks Main afresh on
 * every visit, so a file the user has since moved or rewritten drops off.
 */

import { type LegacyAssetNoticeState, legacyAssetCount } from '@shared/legacyAssets';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { LegacyAssetList, openLegacyAgentFolder } from './LegacyAssetNotice';
import { SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function LegacyAssetsSettings({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<LegacyAssetNoticeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

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

  return (
    <SettingsSectionBlock
      title={t('Items from the previous version')}
      description={t(
        'What the previous version used that this version no longer loads. This only lists them: nothing is changed or deleted.'
      )}
    >
      {error ? (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      ) : !state ? (
        <p className="text-ui text-muted-foreground">{t('Checking...')}</p>
      ) : (
        <div className="space-y-4">
          {count === 0 ? (
            <p className="text-ui text-muted-foreground">
              {t('Nothing from the previous version was found.')}
            </p>
          ) : (
            <LegacyAssetList report={state.report} />
          )}
          <p className="text-meta text-muted-foreground">
            {state.report.workspace
              ? t('Project files were checked in {{path}}.', { path: state.report.workspace })
              : t('Open a workspace to also check its project files.')}
          </p>
          {count > 0 && (
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => void openLegacyAgentFolder().then(setOpenError)}
            >
              <FolderOpen className="h-4 w-4" />
              {t('Open agent folder')}
            </Button>
          )}
          {openError && <p className="text-meta text-destructive">{openError}</p>}
        </div>
      )}
    </SettingsSectionBlock>
  );
}
