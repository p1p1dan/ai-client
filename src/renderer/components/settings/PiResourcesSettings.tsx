import type { PiResourceSettings, UpdatePiResourceSettingsRequest } from '@shared/piModelConfig';
import { Boxes, FolderOpen, Library, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

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
   * The request is a PARTIAL update, so each switch sends only its own field —
   * sending the whole snapshot would let a stale one overwrite whichever switch
   * the user did not touch.
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

  const openResourceFolder = async (kind: 'skills' | 'prompts') => {
    setOpening(true);
    setError(null);
    try {
      if (kind === 'skills') await window.electronAPI.piResources.openSkills();
      else await window.electronAPI.piResources.openPromptTemplates();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSectionBlock
        title={t('Pi Resources')}
        description={t('Install skills and prompt templates where Pi can load them reliably.')}
      />

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
          <section className="space-y-3 border-t p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h4 className="text-ui font-semibold">{t('Shared skills')}</h4>
              </div>
              <Badge variant="success">{t('Default')}</Badge>
            </div>
            <p className="text-meta text-muted-foreground">
              {t(
                'This cross-agent location is always loaded in managed mode, local mode, and the Pi TUI.'
              )}
            </p>
            <ResourcePath label={t('Skills')} path={snapshot.paths.sharedSkills} />
            <Button
              variant="outline"
              onClick={() => void openResourceFolder('skills')}
              disabled={opening}
              className="w-fit"
            >
              <FolderOpen className="h-4 w-4" />
              {opening ? t('Opening...') : t('Open skills folder')}
            </Button>
          </section>

          <section className="space-y-4 border-t p-4">
            <div>
              <h4 className="text-ui font-semibold">{t('This app’s Pi directory')}</h4>
              <p className="text-meta text-muted-foreground">
                {/* H/19: one directory in both modes. Saying "managed mode reads
                    this" would send a local-mode user looking for a second
                    location that no longer exists. cutover-03 split the
                    sentence: pi extensions live here too, but since P6-5 only
                    the TUI loads them. */}
                {t(
                  'Every session in this app — signed in or using your own setup, GUI or Pi TUI — loads skills and prompt templates from here. Installed pi extensions are loaded from here by the Pi TUI only.'
                )}
              </p>
            </div>
            <div className="space-y-2">
              <ResourcePath label={t('Skills')} path={snapshot.paths.appSkills} />
              <ResourcePath
                label={t('Prompt templates')}
                path={snapshot.paths.appPromptTemplates}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void openResourceFolder('prompts')}
              disabled={opening}
              className="w-fit"
            >
              <FolderOpen className="h-4 w-4" />
              {opening ? t('Opening...') : t('Open prompt templates folder')}
            </Button>
          </section>

          <section className="space-y-4 border-t p-4">
            <div>
              <h4 className="text-ui font-semibold">{t('Your personal Pi directory')}</h4>
              <p className="text-meta text-muted-foreground">
                {t(
                  'Where the Pi CLI in your own terminal reads from. This app never writes here, and no longer loads from here — use the copy step above to bring things over.'
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
          </section>

          {/* cutover-10: these switch features of THIS app's own runtime, not
              bundled pi extensions — those were retired in T025 — and each one
              reads the same state the runtime reads, so the page cannot show
              "off" for a session that has the feature on. */}
          <section className="space-y-4 border-t p-4">
            <div className="flex min-w-0 items-center gap-2">
              <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h4 className="text-ui font-semibold">{t('Agent features')}</h4>
            </div>
            {snapshot.features.map((feature) => (
              <SettingsRow key={feature.id} className="sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 flex-1">
                  <p className="text-ui font-medium">{t(feature.label)}</p>
                  <p className="text-meta text-muted-foreground">{t(feature.cost)}</p>
                </div>
                <Switch
                  checked={feature.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    void update({ optInFeatures: { [feature.id]: checked } })
                  }
                  aria-label={t(feature.label)}
                />
              </SettingsRow>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
