/**
 * Decision 168 — the 「模型设置」 block of the add/edit AI service form.
 *
 * A column of the selected models on the left and one shared panel on the
 * right that shows and edits the settings of whichever model is picked in
 * the column. The column is a vertical tab list (WAI-ARIA tabs pattern): its
 * only job is choosing what the single adjacent panel shows, which is exactly
 * what tabs are for; a listbox would announce a form value being chosen, and
 * nothing is chosen by moving through the column. Base UI's tabs supply the
 * roving focus, arrow keys and Home / End.
 *
 * The dialog owns every piece of state (metadata, raw number text, which
 * model is active) and the save; this file only renders it and reports edits.
 * The panel is keyed by the model id so nothing of one model's panel can
 * carry over to the next.
 */

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  IMPLIED_EFFORT_LEVELS,
  MAX_TOKENS_WINDOW_SHARE_FALLBACK,
  MAX_TOKENS_WINDOW_SHARE_LIMIT,
} from '@shared/dshModelPlan/tables';
import {
  availableModelEfforts,
  compatPresetSendsEfforts,
  isModelMetaCustomized,
  isUserCompatPreset,
  normalizeModelEfforts,
  parseModelTokenCount,
  USER_COMPAT_PRESETS,
  USER_MODEL_EFFORTS,
  type UserCompatPreset,
  type UserModelEffort,
  type UserModelMeta,
  type UserProviderApi,
} from '@shared/userProviders';
import { AlertCircle, RotateCcw, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { CHAT_EFFORTS } from '@/components/chat/efforts';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Fieldset, FieldsetLegend } from '@/components/ui/fieldset';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

/** The two number fields, whose raw text the dialog keeps per model. */
export type TokenField = 'contextWindow' | 'maxTokens';
export type TokenDrafts = Partial<Record<TokenField, string>>;

/** Whether any raw number text of a model is not a usable value. */
export function hasInvalidTokenDraft(drafts: TokenDrafts | undefined): boolean {
  if (!drafts) return false;
  return Object.values(drafts).some(
    (raw) => raw !== undefined && parseModelTokenCount(raw).invalid
  );
}

/** Display name's limit; the IPC boundary enforces the same number. */
const MODEL_NAME_MAX = 200;

/** The Select needs a non-empty value for "no preset". */
const PRESET_AUTO = 'auto';

/** Brand names are not translated; the others go through `t`. */
function presetLabel(preset: UserCompatPreset, t: (key: string) => string): string {
  switch (preset) {
    case 'openai':
      return 'OpenAI';
    case 'deepseek':
      return 'DeepSeek';
    case 'qwen':
      return t('Qwen');
    case 'qwen-chat-template':
      return t('Qwen (chat template)');
    case 'zai':
      return t('Zhipu GLM');
    case 'openrouter':
      return 'OpenRouter';
  }
}

interface ModelSettingsPanelProps {
  /** The selected models, in selection order. */
  models: readonly string[];
  /** One of `models`. */
  activeId: string;
  onActiveChange: (modelId: string) => void;
  api: UserProviderApi;
  meta: Readonly<Record<string, UserModelMeta>>;
  drafts: Readonly<Record<string, TokenDrafts>>;
  onPatch: (modelId: string, patch: Partial<UserModelMeta>) => void;
  onTokenDraft: (modelId: string, field: TokenField, raw: string) => void;
  onReset: (modelId: string) => void;
  onRemove: (modelId: string) => void;
}

export function ModelSettingsPanel({
  models,
  activeId,
  onActiveChange,
  api,
  meta,
  drafts,
  onPatch,
  onTokenDraft,
  onReset,
  onRemove,
}: ModelSettingsPanelProps) {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="font-medium text-ui">
        {t('Model settings')}
      </h3>
      <Tabs
        value={activeId}
        onValueChange={(value) => onActiveChange(String(value))}
        orientation="vertical"
        className="items-stretch gap-0 rounded-md border"
      >
        <TabsList
          variant="underline"
          activateOnFocus
          aria-label={t('Selected models')}
          className="max-h-96 w-44 shrink-0 items-stretch justify-start gap-0.5 self-start overflow-y-auto p-1"
        >
          {models.map((modelId) => (
            <ModelTab
              key={modelId}
              modelId={modelId}
              name={meta[modelId]?.name?.trim() || undefined}
              customized={isModelMetaCustomized(modelId, api, meta[modelId])}
              invalid={hasInvalidTokenDraft(drafts[modelId])}
            />
          ))}
        </TabsList>
        <TabsPanel key={activeId} value={activeId} className="min-w-0 space-y-4 border-l p-3">
          <ModelFields
            modelId={activeId}
            api={api}
            meta={meta[activeId] ?? {}}
            drafts={drafts[activeId] ?? {}}
            onPatch={(patch) => onPatch(activeId, patch)}
            onTokenDraft={(field, raw) => onTokenDraft(activeId, field, raw)}
            onReset={() => onReset(activeId)}
            onRemove={() => onRemove(activeId)}
          />
        </TabsPanel>
      </Tabs>
    </section>
  );
}

/** One row of the column: display name over the id, the customized dot, an error mark. */
function ModelTab({
  modelId,
  name,
  customized,
  invalid,
}: {
  modelId: string;
  name: string | undefined;
  customized: boolean;
  invalid: boolean;
}) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <TabsTab
            value={modelId}
            className="h-auto min-h-8 grow-0 gap-2 rounded-sm px-2 py-1 text-left font-normal hover:bg-hover data-active:bg-selection data-active:text-accent-foreground sm:h-auto"
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            customized ? 'bg-primary' : 'bg-transparent'
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-meta">{name ?? modelId}</span>
          {name && <span className="truncate text-meta text-muted-foreground">{modelId}</span>}
        </span>
        {customized && <span className="sr-only">{t('Customized')}</span>}
        {invalid && (
          <>
            <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />
            <span className="sr-only">{t('Has invalid values')}</span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="right" className="max-w-80 break-all">
        {name ? `${name} · ${modelId}` : modelId}
      </TooltipPopup>
    </Tooltip>
  );
}

function ModelFields({
  modelId,
  api,
  meta,
  drafts,
  onPatch,
  onTokenDraft,
  onReset,
  onRemove,
}: {
  modelId: string;
  api: UserProviderApi;
  meta: UserModelMeta;
  drafts: TokenDrafts;
  onPatch: (patch: Partial<UserModelMeta>) => void;
  onTokenDraft: (field: TokenField, raw: string) => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const anthropic = api === 'anthropic-messages';
  const adaptive = anthropic && meta.adaptiveThinking === true;
  const reasoning = meta.reasoning === true || adaptive;
  const showPreset = api === 'openai-completions' && reasoning;
  const preset =
    showPreset && isUserCompatPreset(meta.compatPreset) ? meta.compatPreset : undefined;
  const resettable =
    isModelMetaCustomized(modelId, api, meta) ||
    Object.values(drafts).some((raw) => raw !== undefined);

  const rawText = (field: TokenField): string =>
    drafts[field] ?? (meta[field] !== undefined ? String(meta[field]) : '');
  const invalid = (field: TokenField): boolean => parseModelTokenCount(rawText(field)).invalid;

  return (
    <>
      <div className="flex items-center gap-2">
        <p data-slot="model-settings-id" className="min-w-0 flex-1 truncate font-medium text-meta">
          {modelId}
        </p>
        <IconAction label={t('Reset to defaults')} disabled={!resettable} onClick={onReset}>
          <RotateCcw />
        </IconAction>
        <IconAction label={t('Remove this model')} onClick={onRemove}>
          <X />
        </IconAction>
      </div>

      <Field className="w-full gap-1.5">
        <FieldLabel className="font-normal text-meta text-muted-foreground">
          {t('Display name')}
        </FieldLabel>
        <Input
          value={meta.name ?? ''}
          maxLength={MODEL_NAME_MAX}
          placeholder={modelId}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onPatch({ name: event.target.value || undefined })}
        />
        <FieldDescription className="text-meta">
          {t('Shown in the model menu. Leave empty to use the model ID.')}
        </FieldDescription>
      </Field>

      <PanelSection legend={t('Thinking settings')}>
        <SwitchRow
          label={t('Reasoning')}
          description={t(
            'Turn on for a model that thinks before it answers. A model without reasoning refuses requests sent with it on.'
          )}
          checked={reasoning}
          onCheckedChange={(on) => onPatch({ reasoning: on || undefined })}
        />
        {anthropic && (
          <SwitchRow
            label={t('Adaptive thinking')}
            description={t(
              'Claude Opus / Sonnet 4.6 and later (5.x included) only accept adaptive thinking; older models (Haiku 4.5, Sonnet 4.5 and earlier) need it off.'
            )}
            checked={adaptive}
            onCheckedChange={(on) => onPatch({ adaptiveThinking: on || undefined })}
          />
        )}
        {showPreset && (
          <PresetSelect preset={preset} onChange={(next) => onPatch({ compatPreset: next })} />
        )}
        {reasoning &&
          (compatPresetSendsEfforts(preset) ? (
            <EffortToggles
              api={api}
              adaptive={adaptive}
              efforts={meta.efforts}
              onChange={(efforts) => onPatch({ efforts })}
            />
          ) : (
            <p className="text-meta text-muted-foreground">
              {t(
                'This format only turns thinking on or off and sends no level, so every level in the chat menu behaves the same.'
              )}
            </p>
          ))}
      </PanelSection>

      <PanelSection legend={t('Context and output')}>
        <TokenInput
          label={t('Context window')}
          raw={rawText('contextWindow')}
          placeholder={t('Default {{value}}', { value: DEFAULT_CONTEXT_WINDOW })}
          invalid={invalid('contextWindow')}
          onChange={(raw) => onTokenDraft('contextWindow', raw)}
        />
        <TokenInput
          label={t('Output limit')}
          raw={rawText('maxTokens')}
          placeholder={t('Default {{value}}', { value: DEFAULT_MAX_TOKENS })}
          invalid={invalid('maxTokens')}
          warning={invalid('maxTokens') ? undefined : outputLimitWarning(meta, t)}
          description={
            reasoning
              ? t(
                  'Thinking counts toward the output limit; 32000 or more is recommended for high levels.'
                )
              : undefined
          }
          onChange={(raw) => onTokenDraft('maxTokens', raw)}
        />
      </PanelSection>

      <PanelSection legend={t('Input')}>
        <SwitchRow
          label={t('Image input')}
          description={t('Turn on only for a model that can see images. Text input is always on.')}
          checked={meta.input?.includes('image') === true}
          onCheckedChange={(on) => onPatch({ input: on ? ['text', 'image'] : undefined })}
        />
      </PanelSection>
    </>
  );
}

/**
 * Decision 146: a reply reservation over half the window is planned as a
 * quarter of it — but only when the row declares both numbers. With the
 * window left at its default nothing is clamped, so the advice differs.
 */
function outputLimitWarning(
  meta: UserModelMeta,
  t: (key: string, params?: Record<string, string | number>) => string
): string | undefined {
  const maxTokens = meta.maxTokens;
  if (maxTokens === undefined) return undefined;
  if (meta.contextWindow !== undefined) {
    if (maxTokens <= Math.floor(meta.contextWindow * MAX_TOKENS_WINDOW_SHARE_LIMIT))
      return undefined;
    const planned = Math.max(1, Math.floor(meta.contextWindow * MAX_TOKENS_WINDOW_SHARE_FALLBACK));
    return t(
      'Over half of the context window: the reply reservation is planned as {{value}} tokens (a quarter of the window) so that automatic compaction keeps working.',
      { value: planned }
    );
  }
  if (maxTokens <= Math.floor(DEFAULT_CONTEXT_WINDOW * MAX_TOKENS_WINDOW_SHARE_LIMIT)) {
    return undefined;
  }
  return t(
    'Over half of the default context window ({{window}}): fill in the context window as well, or automatic compaction may have no room to run.',
    { window: DEFAULT_CONTEXT_WINDOW }
  );
}

function PanelSection({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <Fieldset className="max-w-none gap-3 border-t pt-3">
      <FieldsetLegend className="font-medium text-meta">{legend}</FieldsetLegend>
      {children}
    </Fieldset>
  );
}

/** A labelled switch. Not wrapped in a `<label>`: Base UI turns it into a span there. */
function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <div className="w-full space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta">{label}</span>
        <Switch
          aria-label={label}
          aria-describedby={description ? descriptionId : undefined}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {description && (
        <p id={descriptionId} className="text-meta text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function PresetSelect({
  preset,
  onChange,
}: {
  preset: UserCompatPreset | undefined;
  onChange: (preset: UserCompatPreset | undefined) => void;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const label = t('Vendor protocol');
  return (
    <div className="w-full space-y-1.5">
      <span className="text-meta">{label}</span>
      <Select
        value={preset ?? PRESET_AUTO}
        onValueChange={(value) => onChange(isUserCompatPreset(value) ? value : undefined)}
      >
        <SelectTrigger className="w-full" aria-label={label} aria-describedby={descriptionId}>
          <SelectValue>
            {preset ? presetLabel(preset, t) : t('Automatic (by service name and address)')}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_NESTED_MODAL}>
          <SelectItem value={PRESET_AUTO}>
            {t('Automatic (by service name and address)')}
          </SelectItem>
          {USER_COMPAT_PRESETS.map((candidate) => (
            <SelectItem key={candidate} value={candidate}>
              {presetLabel(candidate, t)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p id={descriptionId} className="text-meta text-muted-foreground">
        {t(
          'Decides how thinking, the reasoning level and the output limit are sent. Through a proxy such as new-api, automatic detection sends them the OpenAI way; pick the vendor the model really comes from.'
        )}
      </p>
    </div>
  );
}

/**
 * The offered levels. Levels the style cannot use are shown unpressed and
 * disabled with the reason; the last pressed one is disabled too, since
 * reasoning with no level is not a state the plan can express.
 */
function EffortToggles({
  api,
  adaptive,
  efforts,
  onChange,
}: {
  api: UserProviderApi;
  adaptive: boolean;
  efforts: UserModelEffort[] | undefined;
  onChange: (efforts: UserModelEffort[] | undefined) => void;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const label = t('Available reasoning efforts');
  const available = availableModelEfforts(api, adaptive);
  const pressed =
    normalizeModelEfforts(efforts, api, adaptive) ??
    available.filter((level) => IMPLIED_EFFORT_LEVELS.has(level));
  const unavailableReason = adaptive
    ? t('Adaptive thinking has no Minimal level.')
    : t('Without adaptive thinking, X-High and Max are sent as High.');
  return (
    <div className="w-full space-y-1.5">
      <span className="text-meta">{label}</span>
      <ToggleGroup
        multiple
        variant="outline"
        size="sm"
        className="flex-wrap"
        aria-label={label}
        aria-describedby={descriptionId}
        value={pressed}
        onValueChange={(value) => {
          if (value.length === 0) return;
          onChange(normalizeModelEfforts(value, api, adaptive));
        }}
      >
        {USER_MODEL_EFFORTS.map((level) => {
          const copy = CHAT_EFFORTS.find((effort) => effort.id === level);
          const unavailable = !available.includes(level);
          const lastPressed = pressed.length === 1 && pressed[0] === level;
          const reason = unavailable
            ? unavailableReason
            : lastPressed
              ? t('Keep at least one level while Reasoning is on.')
              : t(copy?.hint ?? level);
          return (
            <Tooltip key={level}>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value={level}
                    disabled={unavailable || lastPressed}
                    className="data-disabled:cursor-not-allowed data-disabled:opacity-64"
                  />
                }
              >
                {t(copy?.label ?? level)}
              </TooltipTrigger>
              <TooltipPopup>{reason}</TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
      <p id={descriptionId} className="text-meta text-muted-foreground">
        {t(
          'Levels offered in the chat\'s reasoning effort menu. "Default" uses Medium when it is offered; without Medium no level is sent and the service decides.'
        )}
      </p>
    </div>
  );
}

function TokenInput({
  label,
  raw,
  placeholder,
  invalid,
  warning,
  description,
  onChange,
}: {
  label: string;
  raw: string;
  placeholder: string;
  invalid: boolean;
  warning?: string;
  description?: string;
  onChange: (raw: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field invalid={invalid} className="w-full gap-1.5">
      <FieldLabel className="font-normal text-meta text-muted-foreground">{label}</FieldLabel>
      <Input
        type="text"
        inputMode="numeric"
        value={raw}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid && (
        <FieldError match className="text-destructive text-meta">
          {t('Enter a whole number greater than 0.')}
        </FieldError>
      )}
      {warning && <FieldDescription className="text-meta text-warning">{warning}</FieldDescription>}
      {description && <FieldDescription className="text-meta">{description}</FieldDescription>}
    </Field>
  );
}

/** A small ghost icon button with a tooltip; the label doubles as its accessible name. */
function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
