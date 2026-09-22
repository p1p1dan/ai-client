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

import type {
  UserModelMeta,
  UserProviderApi,
  UserProviderDraft,
  UserProviderView,
} from '@shared/userProviders';
import {
  checkProviderBaseUrl,
  normalizeProviderBaseUrl,
  PROVIDER_PRESETS,
  USER_PROVIDER_APIS,
} from '@shared/userProviders';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
  const [modelMeta, setModelMeta] = useState<Record<string, UserModelMeta>>({});
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
      setModelMeta(editing.modelMeta ?? {});
      return;
    }
    setPreset(CUSTOM_SERVICE);
    setName('');
    setBaseUrl('');
    setApi('openai-completions');
    setSelected([]);
    setModelMeta({});
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
      // A fetch must not drop what the user already chose. It used to filter
      // `selected` down to the service's answer, which silently deleted a
      // hand-typed model together with the metadata just filled in for it —
      // and gave no sign it had done so. A model the service does not list is
      // the user's call, not this form's: removing it stays explicit, through
      // the row's own X.
      //
      // Nothing is ADDED here, which is the intent this always had: a first
      // fetch must not silently enable the 200 models it returned.
      return;
    }
    setProbe({ state: 'failed', error: result.error });
  }, [baseUrl, api, apiKey, editing]);

  const updateMeta = useCallback((modelId: string, patch: Partial<UserModelMeta>) => {
    setModelMeta((current) => ({ ...current, [modelId]: { ...current[modelId], ...patch } }));
  }, []);

  /**
   * Drop one model from the selection, metadata and all.
   *
   * The row's own removal control exists because the chips below only render
   * once a probe has answered: on an edit opened without fetching, the
   * metadata section is on screen while the only other way to deselect a
   * model is not.
   */
  const removeModel = useCallback((modelId: string) => {
    setSelected((current) => current.filter((id) => id !== modelId));
    setModelMeta((current) => {
      if (!(modelId in current)) return current;
      const rest = { ...current };
      delete rest[modelId];
      return rest;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Only carry metadata for models that are actually selected, and only
      // if at least one field is set — an empty entry is noise pi can do
      // without.
      const meta: Record<string, UserModelMeta> = {};
      for (const id of selected) {
        const m = modelMeta[id];
        if (
          m &&
          (m.contextWindow !== undefined ||
            m.maxTokens !== undefined ||
            m.reasoning !== undefined ||
            m.input !== undefined)
        ) {
          meta[id] = m;
        }
      }
      const draft: UserProviderDraft = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        baseUrl,
        api,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: selected,
        ...(Object.keys(meta).length > 0 ? { modelMeta: meta } : {}),
      };
      await window.electronAPI.userProviders.upsert(draft);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [editing, name, baseUrl, api, apiKey, selected, modelMeta, onSaved, onOpenChange]);

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

            {selected.length > 0 && (
              <details className="rounded-md border">
                <summary className="cursor-pointer select-none px-3 py-2 text-meta text-muted-foreground">
                  {t('Per-model metadata')}
                </summary>
                <div className="space-y-3 border-t px-3 py-3">
                  {selected.map((model) => (
                    <ModelMetaRow
                      key={model}
                      modelId={model}
                      meta={modelMeta[model]}
                      onChange={updateMeta}
                      onRemove={removeModel}
                    />
                  ))}
                </div>
              </details>
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

/**
 * One row of per-model metadata: context window, output cap, reasoning switch
 * and input modality. All optional; a blank row is the same as no metadata.
 */
function ModelMetaRow({
  modelId,
  meta,
  onChange,
  onRemove,
}: {
  modelId: string;
  meta: UserModelMeta | undefined;
  onChange: (modelId: string, patch: Partial<UserModelMeta>) => void;
  onRemove: (modelId: string) => void;
}) {
  const { t } = useI18n();
  const input = meta?.input ?? [];
  // `min={0}` only clamps the spinner, not typing; `Number('1e999')` is
  // `Infinity` which `JSON.stringify` turns to `null`, and pi's `parseModel`
  // silently drops anything that is not a positive integer. So invalid input
  // is dropped here rather than written as a number pi will ignore.
  const toPositiveInt = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-meta font-semibold">{modelId}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          aria-label={t('Remove')}
          onClick={() => onRemove(modelId)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1.5 text-meta text-muted-foreground">
          {t('Context window')}
          <Input
            type="number"
            min={1}
            className="h-7 w-28"
            value={meta?.contextWindow ?? ''}
            onChange={(event) =>
              onChange(modelId, { contextWindow: toPositiveInt(event.target.value) })
            }
            placeholder="tokens"
          />
        </label>
        <label className="flex items-center gap-1.5 text-meta text-muted-foreground">
          {t('Output limit')}
          <Input
            type="number"
            min={1}
            className="h-7 w-28"
            value={meta?.maxTokens ?? ''}
            onChange={(event) =>
              onChange(modelId, { maxTokens: toPositiveInt(event.target.value) })
            }
            placeholder="tokens"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <input
            type="checkbox"
            checked={meta?.reasoning === true}
            onChange={(event) =>
              onChange(modelId, { reasoning: event.target.checked || undefined })
            }
          />
          {t('Reasoning')}
        </label>
        <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
          {t('Input')}
          <ToggleGroup
            value={input}
            onValueChange={(value) =>
              onChange(modelId, {
                input:
                  (value as string[]).length > 0
                    ? ([...value] as Array<'text' | 'image'>)
                    : undefined,
              })
            }
          >
            <ToggleGroupItem value="text">{t('Text')}</ToggleGroupItem>
            <ToggleGroupItem value="image">{t('Image')}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    </div>
  );
}

/** Used by the list view to badge a service with its request style. */
export function apiLabel(api: UserProviderApi): string {
  return API_LABELS[api];
}
