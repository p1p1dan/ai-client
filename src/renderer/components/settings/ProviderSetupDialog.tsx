/**
 * H/17 L3 — the add/edit form for one AI service.
 *
 * Adapted from PI-Desktop's `ProviderSetupDialog.tsx`: pick a known service or
 * describe a custom one, then let the service itself say which models it has.
 * The markup is this repo's own — @coss/ui components and design tokens per
 * `docs/design-system.md`, not PI-Desktop's hand-written CSS classes.
 *
 * ## The key is write-only
 *
 * Editing an existing service starts with an EMPTY key field and the note that
 * one is stored. Leaving it empty keeps the stored key; typing replaces it.
 * The stored value is never sent to the renderer, so there is nothing here to
 * pre-fill it with even if we wanted to.
 */

import type { UserProviderApi, UserProviderDraft, UserProviderView } from '@shared/userProviders';
import {
  checkProviderBaseUrl,
  normalizeProviderBaseUrl,
  PROVIDER_PRESETS,
  USER_PROVIDER_APIS,
} from '@shared/userProviders';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

const CUSTOM_SERVICE = 'custom';

/** Labels for the API styles, keyed by the pi-ai id we store. */
const API_LABELS: Record<UserProviderApi, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'openai-codex-responses': 'OpenAI Codex Responses',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
  'google-vertex': 'Google Vertex',
  'bedrock-converse-stream': 'Amazon Bedrock Converse',
  'mistral-conversations': 'Mistral Conversations',
  'pi-messages': 'Pi Messages',
};

interface ProviderSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent when adding. */
  editing?: UserProviderView;
  onSaved: () => void;
}

type Probe =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; models: string[] }
  | { state: 'failed'; error: string };

export function ProviderSetupDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: ProviderSetupDialogProps) {
  const { t } = useI18n();
  const [preset, setPreset] = useState<string>(CUSTOM_SERVICE);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<UserProviderApi>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed on every open so a cancelled edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setProbe({ state: 'idle' });
    setSaveError(null);
    setApiKey('');
    if (editing) {
      const matched = PROVIDER_PRESETS.find(
        (candidate) =>
          normalizeProviderBaseUrl(candidate.baseUrl, candidate.api) === editing.baseUrl
      );
      setPreset(matched?.id ?? CUSTOM_SERVICE);
      setName(editing.name);
      setBaseUrl(editing.baseUrl);
      setApi(editing.api);
      setSelected(editing.models);
      return;
    }
    setPreset(CUSTOM_SERVICE);
    setName('');
    setBaseUrl('');
    setApi('openai-completions');
    setSelected([]);
  }, [open, editing]);

  const applyPreset = useCallback((id: string | null) => {
    setPreset(id ?? CUSTOM_SERVICE);
    setProbe({ state: 'idle' });
    const found = PROVIDER_PRESETS.find((candidate) => candidate.id === id);
    if (!found) return;
    setName(found.label);
    setBaseUrl(found.baseUrl);
    setApi(found.api);
  }, []);

  const urlIssue = useMemo(() => (baseUrl ? checkProviderBaseUrl(baseUrl) : null), [baseUrl]);
  // On edit, an empty key field means "keep the stored one", so it is not a
  // reason to block either the probe or the save.
  const hasUsableKey = apiKey.trim().length > 0 || Boolean(editing?.hasApiKey);
  const canProbe = Boolean(baseUrl) && !urlIssue && hasUsableKey && probe.state !== 'running';
  const canSave = Boolean(name.trim()) && canProbe;

  const runProbe = useCallback(async () => {
    setProbe({ state: 'running' });
    const result = await window.electronAPI.userProviders.fetchModels({
      baseUrl,
      api,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(editing ? { id: editing.id } : {}),
    });
    if (result.ok) {
      setProbe({ state: 'ok', models: result.models });
      // Pre-select what was already chosen; on a first fetch, nothing, so the
      // user makes a deliberate choice rather than silently enabling 200 models.
      setSelected((current) => current.filter((id) => result.models.includes(id)));
      return;
    }
    setProbe({ state: 'failed', error: result.error });
  }, [baseUrl, api, apiKey, editing]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const draft: UserProviderDraft = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        baseUrl,
        api,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: selected,
      };
      await window.electronAPI.userProviders.upsert(draft);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [editing, name, baseUrl, api, apiKey, selected, onSaved, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Opened from within SettingsDialog: must render above the base modal, not rely on DOM mount order */}
      <DialogPopup className="max-w-lg" zIndexLevel="nested">
        <DialogHeader>
          <DialogTitle>{editing ? t('Edit AI service') : t('Add AI service')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field label={t('Service')}>
            <Select value={preset} onValueChange={applyPreset}>
              <SelectTrigger className="w-full" aria-label={t('Service')}>
                <SelectValue>
                  {PROVIDER_PRESETS.find((candidate) => candidate.id === preset)?.label ??
                    t('Custom')}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_NESTED_MODAL}>
                {PROVIDER_PRESETS.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SERVICE}>{t('Custom')}</SelectItem>
              </SelectPopup>
            </Select>
          </Field>

          <Field label={t('Name')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('Shown in the model picker')}
            />
          </Field>

          <Field
            label={t('Service URL')}
            hint={
              urlIssue
                ? urlIssue === 'insecure'
                  ? t('Use an http or https address.')
                  : t('This address cannot be used. Remove any query string, or credentials in it.')
                : undefined
            }
            invalid={Boolean(urlIssue)}
          >
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={(event) => setBaseUrl(normalizeProviderBaseUrl(event.target.value, api))}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
            />
          </Field>

          <Field label={t('API style')}>
            <Select value={api} onValueChange={(value) => setApi(value as UserProviderApi)}>
              <SelectTrigger className="w-full" aria-label={t('API style')}>
                <SelectValue>{API_LABELS[api]}</SelectValue>
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_NESTED_MODAL}>
                {USER_PROVIDER_APIS.map((style) => (
                  <SelectItem key={style} value={style}>
                    {API_LABELS[style]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field
            label={t('API key')}
            hint={editing?.hasApiKey ? t('A key is stored. Leave empty to keep it.') : undefined}
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={editing?.hasApiKey ? '••••••••' : ''}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={runProbe} disabled={!canProbe}>
                {probe.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('Fetch models')}
              </Button>
              {probe.state === 'ok' && (
                <span className="flex items-center gap-1.5 text-meta text-success">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  {t('{{count}} models available').replace('{{count}}', `${probe.models.length}`)}
                </span>
              )}
            </div>

            {probe.state === 'failed' && (
              <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-2 text-meta text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {/* The service's own words: "refused this key" and "answered
                    500" send the user to different places. */}
                {t('Could not reach this service — {{reason}}').replace('{{reason}}', probe.error)}
              </p>
            )}

            {probe.state === 'ok' && (
              <ScrollArea className="max-h-48 rounded-md border">
                <div className="flex flex-wrap gap-1.5 p-2">
                  {probe.models.map((model) => {
                    const on = selected.includes(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setSelected((current) =>
                            on ? current.filter((id) => id !== model) : [...current, model]
                          )
                        }
                        className={cn(
                          'rounded-sm border px-2 py-0.5 text-meta transition-colors',
                          on
                            ? 'border-accent bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent/50'
                        )}
                      >
                        {model}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            )}

            {selected.length > 0 && (
              <p className="text-meta text-muted-foreground">
                {t('{{count}} selected').replace('{{count}}', `${selected.length}`)}
              </p>
            )}
          </div>

          {saveError && (
            <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-2 text-meta text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {saveError}
            </p>
          )}
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost">{t('Cancel')}</Button>} />
          <Button onClick={save} disabled={!canSave || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-meta text-muted-foreground">{label}</span>
      {children}
      {hint && (
        <p className={cn('text-meta', invalid ? 'text-destructive' : 'text-muted-foreground')}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Used by the list view to badge a service with its request style. */
export function apiLabel(api: UserProviderApi): string {
  return API_LABELS[api];
}
