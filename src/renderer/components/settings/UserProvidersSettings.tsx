/**
 * H/17 L3 — the "AI services" section of the Pi settings page.
 *
 * Lists what the user added, and is the only way to add one. Adapted from
 * PI-Desktop's `ModelConfigPage.tsx` providers section.
 *
 * Shown in BOTH credential modes: the two groups are stored separately and a
 * managed sync never touches the user's own services, so there is no reason to
 * hide the feature from someone who is signed in and wants to point one session
 * at their own account.
 */

import type { UserProviderState, UserProviderView } from '@shared/userProviders';
import { AlertTriangle, Pencil, Plus, Server, ShieldOff, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { apiLabel, ProviderSetupDialog } from './ProviderSetupDialog';
import { SettingsSectionBlock } from './SettingsPrimitives';

export function UserProvidersSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<UserProviderState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserProviderView | undefined>();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await window.electronAPI.userProviders.get());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setError(null);
      try {
        await run();
        await load();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      }
    },
    [load]
  );

  const providers = state?.providers ?? [];

  return (
    <div className="space-y-4">
      <SettingsSectionBlock
        title={t('AI services')}
        description={t('Services you add yourself. Keys are stored on this machine only.')}
      />

      {state && !state.encrypted && (
        // H/17 constraint 3: the vault falls back to plaintext when the OS
        // keyring is unavailable. Discovering that by reading the file is not
        // an acceptable way to find out.
        <div className="flex gap-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-ui text-warning">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          {t('The system keyring is unavailable, so keys are stored unencrypted on this machine.')}
        </div>
      )}

      {state?.unavailable === 'locked' && (
        <div className="flex gap-3 rounded-md border border-info/30 bg-info/10 p-3 text-ui text-info">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('Unlock the system keyring to see and change your AI services.')}
        </div>
      )}

      {state?.unavailable === 'invalid' && (
        <div className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('Stored AI services could not be read. Adding one again will replace the record.')}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-ui font-semibold">
          {t('Configured')}
          {providers.length > 0 && (
            <Badge className="ml-2" variant="secondary">
              {providers.length}
            </Badge>
          )}
        </span>
        <Button
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
          disabled={state?.unavailable === 'locked'}
        >
          <Plus className="h-4 w-4" />
          {t('Add service')}
        </Button>
      </div>

      {providers.length === 0 ? (
        <Empty className="border rounded-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Server className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>{t('No AI services yet')}</EmptyTitle>
            <EmptyDescription>
              {t('Add one to use your own model provider in this app.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className={cn(
                'flex items-center gap-3 p-3',
                !provider.enabled && 'text-muted-foreground'
              )}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-ui font-medium">{provider.name}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {apiLabel(provider.api)}
                  </Badge>
                </div>
                <p className="truncate text-meta text-muted-foreground">{provider.baseUrl}</p>
                <p className="text-meta text-muted-foreground">
                  {provider.models.length > 0
                    ? t('{{count}} models').replace('{{count}}', `${provider.models.length}`)
                    : t('No models selected')}
                </p>
              </div>
              <Switch
                checked={provider.enabled}
                onCheckedChange={(checked) =>
                  act(() => window.electronAPI.userProviders.setEnabled(provider.id, checked))
                }
                aria-label={t('Enabled')}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('Edit')}
                onClick={() => {
                  setEditing(provider);
                  setDialogOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('Remove')}
                onClick={() => act(() => window.electronAPI.userProviders.remove(provider.id))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <ProviderSetupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={load}
      />
    </div>
  );
}
