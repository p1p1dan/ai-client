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
  applyModelMetaPatch,
  checkProviderBaseUrl,
  isSupportedUserProviderApi,
  modelMetaDraft,
  normalizeProviderBaseUrl,
  PROVIDER_PRESETS,
  parseModelTokenCount,
  prefillModelMeta,
  SUPPORTED_USER_PROVIDER_APIS,
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
import {
  hasInvalidTokenDraft,
  ModelSettingsPanel,
  type TokenDrafts,
  type TokenField,
} from './ModelSettingsPanel';

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

/**
 * dsh-rebase P1-5d (decision 036 rule 2, decision 148): the presets a NEW
 * service can pick from. `PROVIDER_PRESETS` itself is left whole — it is
 * `USER_PROVIDER_APIS`-shaped, not DSH-shaped, and stays the record of what
 * pi-ai's adapters can reach (relevant again if a self-written adapter plugin
 * is ever built, per decision 036's idea-pool note). Picking a preset only
 * pre-fills form fields; it writes nothing on its own, so dropping two of the
 * sixteen entries here cannot lose stored data.
 */
const SELECTABLE_PRESETS = PROVIDER_PRESETS.filter((preset) =>
  isSupportedUserProviderApi(preset.api)
);

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
  // Decision 168: the raw text of the number fields, per model, so a value
  // that is not a number yet stays on screen (and blocks the save) instead of
  // vanishing — and never leaks into another model's panel.
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, TokenDrafts>>({});
  // The model the settings panel shows. Kept as a wish, not a fact: see `activeModel`.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed on every open so a cancelled edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setProbe({ state: 'idle' });
    setSaveError(null);
    setApiKey('');
    setTokenDrafts({});
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
      setActiveId(editing.models[0] ?? null);
      return;
    }
    setPreset(CUSTOM_SERVICE);
    setName('');
    setBaseUrl('');
    setApi('openai-completions');
    setSelected([]);
    setModelMeta({});
    setActiveId(null);
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

  // dsh-rebase P1-5d (decision 036 rule 2, decision 148). A new service only
  // ever has `api` set to one of the three supported styles (the initial
  // state and every preset in `SELECTABLE_PRESETS` are), so this only widens
  // the list when editing a service that already carries an unsupported one —
  // pinning it in rather than leaving it off the list keeps the current
  // choice visible and selected instead of orphaning it.
  const selectableApis = useMemo<readonly UserProviderApi[]>(
    () =>
      isSupportedUserProviderApi(api)
        ? SUPPORTED_USER_PROVIDER_APIS
        : [...SUPPORTED_USER_PROVIDER_APIS, api],
    [api]
  );
  const apiUnsupported = !isSupportedUserProviderApi(api);

  const urlIssue = useMemo(() => (baseUrl ? checkProviderBaseUrl(baseUrl) : null), [baseUrl]);
  // On edit, an empty key field means "keep the stored one", so it is not a
  // reason to block either the probe or the save.
  const hasUsableKey = apiKey.trim().length > 0 || Boolean(editing?.hasApiKey);
  const canProbe = Boolean(baseUrl) && !urlIssue && hasUsableKey && probe.state !== 'running';
  // Decision 168: a number that is not one yet blocks the save, wherever it is.
  const invalidModels = useMemo(
    () => selected.filter((model) => hasInvalidTokenDraft(tokenDrafts[model])),
    [selected, tokenDrafts]
  );
  const canSave = Boolean(name.trim()) && canProbe && invalidModels.length === 0;
  // Unticking or removing the shown model falls back to the first selected one.
  const activeModel =
    activeId !== null && selected.includes(activeId) ? activeId : (selected[0] ?? null);

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
      // the settings panel's own X.
      //
      // Nothing is ADDED here, which is the intent this always had: a first
      // fetch must not silently enable the 200 models it returned.
      return;
    }
    setProbe({ state: 'failed', error: result.error });
  }, [baseUrl, api, apiKey, editing]);

  const updateMeta = useCallback(
    (modelId: string, patch: Partial<UserModelMeta>) => {
      setModelMeta((current) => ({
        ...current,
        [modelId]: applyModelMetaPatch(current[modelId], patch, api),
      }));
    },
    [api]
  );

  /**
   * A number field's text. A usable value (or an empty field) goes into the
   * metadata at once; anything else stays as text only, marked and blocking
   * the save, so the stored value is never silently dropped (decision 168).
   */
  const updateTokenDraft = useCallback(
    (modelId: string, field: TokenField, raw: string) => {
      setTokenDrafts((current) => ({
        ...current,
        [modelId]: { ...current[modelId], [field]: raw },
      }));
      const parsed = parseModelTokenCount(raw);
      if (!parsed.invalid) updateMeta(modelId, { [field]: parsed.value });
    },
    [updateMeta]
  );

  /**
   * A chip click. Ticking a model makes it the one the settings panel shows
   * (focus stays on the chip). Selecting a Claude model that only accepts
   * adaptive thinking fills that in for it (decisions 165, 168, user rulings
   * 2026-10-09) when the model has no metadata yet. Unticking keeps whatever
   * was set, so ticking it again restores it rather than prefilling anew.
   */
  const toggleModel = useCallback(
    (model: string, on: boolean) => {
      if (on) {
        setSelected((current) => current.filter((id) => id !== model));
        return;
      }
      setSelected((current) => (current.includes(model) ? current : [...current, model]));
      setActiveId(model);
      const prefill = prefillModelMeta(model, api, modelMeta[model]);
      if (!prefill) return;
      setModelMeta((current) => ({ ...current, [model]: prefill }));
    },
    [api, modelMeta]
  );

  /**
   * Back to what a fresh selection would get: the prefill for an adaptive-only
   * Claude, nothing for anything else (decision 168). Typed text goes too.
   */
  const resetModel = useCallback(
    (modelId: string) => {
      const defaults = prefillModelMeta(modelId, api, undefined);
      setModelMeta((current) => {
        const rest = { ...current };
        if (defaults) rest[modelId] = defaults;
        else delete rest[modelId];
        return rest;
      });
      setTokenDrafts((current) => {
        if (!(modelId in current)) return current;
        const rest = { ...current };
        delete rest[modelId];
        return rest;
      });
    },
    [api]
  );

  /**
   * Drop one model from the selection, metadata and all.
   *
   * The panel's own removal control exists because the chips only render
   * once a probe has answered: on an edit opened without fetching, the
   * settings panel is on screen while the only other way to deselect a
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
    setTokenDrafts((current) => {
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
      // Only selected models and set fields; sent as `{}` when an edit cleared
      // what the service has stored (decision 165).
      const meta = modelMetaDraft({
        selected,
        meta: modelMeta,
        api,
        stored: editing?.modelMeta,
      });
      const draft: UserProviderDraft = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        baseUrl,
        api,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: selected,
        ...(meta ? { modelMeta: meta } : {}),
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
      {/* Decision 168: wide enough for the model column beside the settings panel. */}
      <DialogPopup className="max-w-2xl" zIndexLevel="nested">
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
                {SELECTABLE_PRESETS.map((candidate) => (
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

          <Field
            label={t('API style')}
            hint={
              apiUnsupported
                ? t(
                    'This service uses {{api}}, which the current chat engine cannot use. Pick one of the styles above, or remove the service.',
                    { api: API_LABELS[api] }
                  )
                : t('Only these three API styles work with the current chat engine.')
            }
            invalid={apiUnsupported}
          >
            <Select value={api} onValueChange={(value) => setApi(value as UserProviderApi)}>
              <SelectTrigger className="w-full" aria-label={t('API style')}>
                <SelectValue>{API_LABELS[api]}</SelectValue>
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_NESTED_MODAL}>
                {selectableApis.map((style) => (
                  <SelectItem key={style} value={style}>
                    {isSupportedUserProviderApi(style)
                      ? API_LABELS[style]
                      : t('{{label}} (not supported by the current engine)', {
                          label: API_LABELS[style],
                        })}
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
                <div
                  role="group"
                  aria-label={t('Available models')}
                  className="flex flex-wrap gap-1.5 p-2"
                >
                  {probe.models.map((model) => {
                    const on = selected.includes(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleModel(model, on)}
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

            {probe.state === 'ok' && selected.length === 0 && (
              <p className="text-meta text-muted-foreground">
                {t('Select models above to configure them here.')}
              </p>
            )}
          </div>

          {activeModel !== null && (
            <ModelSettingsPanel
              models={selected}
              activeId={activeModel}
              onActiveChange={setActiveId}
              api={api}
              meta={modelMeta}
              drafts={tokenDrafts}
              onPatch={updateMeta}
              onTokenDraft={updateTokenDraft}
              onReset={resetModel}
              onRemove={removeModel}
            />
          )}

          {invalidModels.length > 0 && (
            <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-2 text-meta text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t(
                'Some model settings are not valid. Fix the models marked in the list, then save.'
              )}
            </p>
          )}

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
