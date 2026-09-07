import type { PiResourceSettings, UpdatePiResourceSettingsRequest } from '@shared/piModelConfig';
import { Boxes, FolderOpen, Library, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function ResourcePath({ label, path }: { label: string; path: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[120px_1fr] sm:gap-3">
      <span className="text-meta text-muted-foreground">{label}</span>
      <Ident className="min-w-0 break-all">{path}</Ident>
    </div>
  );
}

export function PiResourcesSettings() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PiResourceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await window.electronAPI.piResources.getSettings());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One writer for both switches. The request is a PARTIAL update, so each
   * toggle sends only its own field — sending the pair would let a stale
   * snapshot overwrite whichever switch the user did not touch.
   */
  const update = async (patch: UpdatePiResourceSettingsRequest) => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.electronAPI.piResources.updateSettings(patch));
    } catch (cause) {
      const message = messageOf(cause);
      await load();
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const openPromptTemplates = async () => {
    setOpening(true);
    setError(null);
    try {
      await window.electronAPI.piResources.openPromptTemplates();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-title font-semibold tracking-[-0.01em]">{t('Pi Resources')}</h3>
        <p className="text-ui text-muted-foreground">
          {t('Install skills and prompt templates where Pi can load them reliably.')}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {!snapshot ? (
        <p className="text-ui text-muted-foreground">{t('Loading resource settings...')}</p>
      ) : (
        <>
          <section className="space-y-3 rounded-md border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h4 className="text-ui font-semibold">{t('Shared skills')}</h4>
              </div>
              <Badge variant="success">{t('Recommended')}</Badge>
            </div>
            <p className="text-meta text-muted-foreground">
              {t(
                'This cross-agent location is always loaded in managed mode, local mode, and the Pi TUI.'
              )}
            </p>
            <ResourcePath label={t('Skills')} path={snapshot.paths.sharedSkills} />
          </section>

          <section className="space-y-4 rounded-md border bg-card p-4">
            <div>
              <h4 className="text-ui font-semibold">{t('Personal Pi directory')}</h4>
              <p className="text-meta text-muted-foreground">
                {t(
                  'Local setup reads this directory directly in GUI and Pi TUI. Managed GUI sessions can borrow its text resources without loading its settings, credentials, or plugins.'
                )}
              </p>
            </div>
            <div className="space-y-2">
              <ResourcePath label={t('Skills')} path={snapshot.paths.userSkills} />
              <ResourcePath
                label={t('Prompt templates')}
                path={snapshot.paths.userPromptTemplates}
              />
            </div>
            {!snapshot.managed && (
              <Button
                variant="outline"
                onClick={() => void openPromptTemplates()}
                disabled={opening}
                className="w-fit"
              >
                <FolderOpen className="h-4 w-4" />
                {opening ? t('Opening...') : t('Open prompt templates folder')}
              </Button>
            )}
            <div className="flex items-start justify-between gap-4 border-t pt-4">
              <div className="min-w-0 flex-1">
                <p className="text-ui font-medium">{t('Borrow personal Pi resources')}</p>
                <p className="text-meta text-muted-foreground">
                  {snapshot.managed
                    ? t(
                        'Applies to GUI sessions. Changing it reloads managed Pi workers; the embedded Pi TUI still uses only the app-managed directory.'
                      )
                    : t(
                        'Your current local setup already uses this directory. This switch is saved for managed mode.'
                      )}
                </p>
              </div>
              <Switch
                checked={snapshot.borrowUserPiResources}
                disabled={busy}
                onCheckedChange={(checked) => void update({ borrowUserPiResources: checked })}
                aria-label={t('Borrow personal Pi resources')}
              />
            </div>
          </section>

          <section className="space-y-4 rounded-md border bg-card p-4">
            <div className="flex min-w-0 items-center gap-2">
              <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h4 className="text-ui font-semibold">{t('Bundled extensions')}</h4>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-ui font-medium">{t('Sub-agents')}</p>
                <p className="text-meta text-muted-foreground">
                  {t(
                    'Lets the model delegate work to background agents. Off by default: its tool definitions are sent with every request, so it costs tokens on every turn even when unused. Changing it reloads Pi workers.'
                  )}
                </p>
              </div>
              <Switch
                checked={snapshot.enableSubagents}
                disabled={busy}
                onCheckedChange={(checked) => void update({ enableSubagents: checked })}
                aria-label={t('Sub-agents')}
              />
            </div>
          </section>

          <section className="space-y-4 rounded-md border bg-card p-4">
            <div>
              <h4 className="text-ui font-semibold">{t('App-managed Pi directory')}</h4>
              <p className="text-meta text-muted-foreground">
                {snapshot.managed
                  ? t(
                      'Managed mode reads this app-profile directory in both GUI and Pi TUI sessions.'
                    )
                  : t('This app-profile directory becomes active when managed mode is used.')}
              </p>
            </div>
            <div className="space-y-2">
              <ResourcePath label={t('Skills')} path={snapshot.paths.managedSkills} />
              <ResourcePath
                label={t('Prompt templates')}
                path={snapshot.paths.managedPromptTemplates}
              />
            </div>
            {snapshot.managed && (
              <Button
                variant="outline"
                onClick={() => void openPromptTemplates()}
                disabled={opening}
                className="w-fit"
              >
                <FolderOpen className="h-4 w-4" />
                {opening ? t('Opening...') : t('Open prompt templates folder')}
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
