import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  agentDefaultEffort,
  agentDefaultModel,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { useSettingsHydrated, useSettingsStore } from '@/stores/settings';
import {
  type ComposerMenuItem,
  type ComposerMenuSection,
  composerModelLabelParts,
  composerModelMenuModel,
} from './composerModel';
import {
  EFFORT_DEFAULT_ID,
  effortsForModel,
  reconcileEffortForModel,
  resolveEffortSelection,
} from './efforts';
import type { HostStatus } from './hostStatus';
import {
  composerMenuGroupLabelClass,
  composerMenuItemClass,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import {
  AUTOMATIC_MODEL_ID,
  AUTOMATIC_MODEL_LABEL,
  filterChatModels,
  groupChatModels,
  modelOptionsFor,
  modelScopeHint,
  modelVerification,
  resolveModelSelection,
  unverifiedModelLabel,
} from './models';
import { catalogModels } from './piModelCatalog';
import { captureSessionGenerationPreferences } from './sessionGenerationPreferences';
import { usePiModelCatalog } from './usePiModelCatalog';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

/**
 * T-30b2: the Composer's single model + reasoning-effort control, replacing
 * the former `ModelSelect` + `EffortSelect` pair.
 *
 * Each session owns its model and effort, including inherited defaults.
 * Switching sessions remounts both selections together. Explicit picks also
 * update the defaults for future chats; a catalog refresh only reconciles the
 * current chat's effort against that model's capabilities.
 *
 * `Menu` rather than `Select`: a `Select` models ONE value, and this popup
 * holds two orthogonal radio groups. `Menu.RadioGroup` is the primitive that
 * says so, and it is the same family the target-row dropdowns already use —
 * which is where `data-[popup-open]` in the trigger class comes from.
 */

interface ComposerModelTriggerProps {
  /**
   * U29: `null` before the conversation exists. The control stays live — pix
   * never lets its model menu go blank ("survives snapshot gaps so composer
   * never flashes 未选择模型") — and in that state it reads and writes ONLY
   * the global template (`chatAgentDefaults`), which is where a pick made now
   * has to land: there is no chat to attach a per-chat value to, and the
   * template is already what a new chat inherits.
   */
  sessionId: string | null;
  /** Host-reported default model id from `host.ready.settings.model`, if seen. */
  hostDefaultModel?: string | null;
  /** Gates the catalog request — nothing is fetched before the Host is up. */
  hostState: HostStatus['state'];
  /** Which way the popup opens — the docked card has no room below it. */
  mode: MiddleColumnMode;
  disabled?: boolean;
}

/**
 * Menu rows are built from primitives rather than the shared `MenuRadioItem`
 * for one reason: the check mark belongs on the RIGHT (matching the reference,
 * and matching how the label reads), while the shared item pins its indicator
 * to a left grid column.
 *
 * The row/label classes themselves moved to `middleColumnLayout` in D4, where
 * `ComposerAttachMenu` shares them — including the note on why they are not
 * `components/ui/menu.tsx`'s `MenuItem` and why the font-size tokens are
 * written as plain strings.
 */
function MenuRadioRows({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly ComposerMenuItem[];
  selectedId: string | null;
  onSelect: (itemId: string) => void;
}) {
  return (
    <MenuRadioGroup value={selectedId}>
      {items.map((item) => (
        <MenuPrimitive.RadioItem
          key={item.id}
          value={item.id}
          className={composerMenuItemClass()}
          title={item.hint}
          closeOnClick={false}
          onClick={() => onSelect(item.id)}
        >
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <MenuPrimitive.RadioItemIndicator className="shrink-0">
            <Check className="size-3.5" />
          </MenuPrimitive.RadioItemIndicator>
        </MenuPrimitive.RadioItem>
      ))}
    </MenuRadioGroup>
  );
}

function ModelMenuSection({
  section,
  onSelect,
  query = '',
  fallbackGroupLabel = 'Other models',
}: {
  section: ComposerMenuSection;
  onSelect: (sectionId: ComposerMenuSection['id'], itemId: string) => void;
  query?: string;
  fallbackGroupLabel?: string;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const selectedId = section.items.find((item) => item.selected)?.id ?? null;
  if (section.id === 'model') {
    // Q2 hides the menu choice; stored Automatic values keep their runtime semantics.
    const direct = section.items.filter(
      (item) => item.id !== AUTOMATIC_MODEL_ID && item.verified === false
    );
    const matches = filterChatModels(
      section.items.filter((item) => item.id !== AUTOMATIC_MODEL_ID && item.verified !== false),
      query
    );
    const grouped = groupChatModels([...direct, ...matches], fallbackGroupLabel);
    return (
      <MenuGroup>
        <MenuPrimitive.GroupLabel className={composerMenuGroupLabelClass()}>
          {section.label}
        </MenuPrimitive.GroupLabel>
        <MenuRadioRows
          items={grouped.direct as ComposerMenuItem[]}
          selectedId={selectedId}
          onSelect={(itemId) => onSelect(section.id, itemId)}
        />
        {grouped.groups.map((group) => {
          const items = group.items as ComposerMenuItem[];
          const selected = items.some((item) => item.id === selectedId);
          return (
            <MenuSub
              key={group.id}
              open={openGroup === group.id}
              onOpenChange={(open) => setOpenGroup(open ? group.id : null)}
            >
              <MenuSubTrigger className={composerMenuItemClass()}>
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                {selected ? <Check className="size-3.5 shrink-0" /> : null}
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]">
                <MenuRadioRows
                  items={items}
                  selectedId={selectedId}
                  onSelect={(itemId) => {
                    onSelect(section.id, itemId);
                    setOpenGroup(null);
                  }}
                />
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuGroup>
    );
  }

  return (
    <MenuGroup>
      <MenuPrimitive.GroupLabel className={composerMenuGroupLabelClass()}>
        {section.label}
      </MenuPrimitive.GroupLabel>
      <MenuRadioRows
        items={section.items}
        selectedId={selectedId}
        onSelect={(itemId) => onSelect(section.id, itemId)}
      />
    </MenuGroup>
  );
}

export function ComposerModelTrigger(props: ComposerModelTriggerProps) {
  // Model, effort and open submenus belong to one session. Remount together so
  // an effect can never reconcile the previous chat's effort into the next one.
  return <SessionModelTrigger key={props.sessionId ?? 'new-chat'} {...props} />;
}

function SessionModelTrigger({
  sessionId,
  hostDefaultModel,
  hostState,
  mode,
  disabled,
}: ComposerModelTriggerProps) {
  const { t } = useI18n();
  const { getSessionModel, setSessionModel } = useSessionModel();
  const { getSessionEffort, setSessionEffort } = useSessionEffort();
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const setChatAgentDefaults = useSettingsStore((state) => state.setChatAgentDefaults);
  const settingsHydrated = useSettingsHydrated();

  const { catalog, authoritative, loading, status, refresh, retry } = usePiModelCatalog(hostState);
  const catalogOptions = catalogModels(catalog);

  useEffect(() => {
    if (sessionId && settingsHydrated) {
      captureSessionGenerationPreferences(sessionId, chatAgentDefaults);
    }
  }, [sessionId, chatAgentDefaults, settingsHydrated]);

  const [model, setModel] = useState<string>(() =>
    resolveModelSelection({
      storedModel: sessionId ? getSessionModel(sessionId) : null,
      agentDefaultModel: agentDefaultModel(chatAgentDefaults),
      catalog: catalogOptions,
      hostDefaultModel,
    })
  );
  const [effort, setEffort] = useState<string>(
    () =>
      resolveEffortSelection(
        sessionId ? getSessionEffort(sessionId) : null,
        agentDefaultEffort(chatAgentDefaults)
      ) ?? EFFORT_DEFAULT_ID
  );
  const [modelQuery, setModelQuery] = useState('');
  const [open, setOpen] = useState(false);

  // Session changes remount this state. Re-read saved preferences after defaults
  // hydrate; the catalog affects labels, never the saved model choice.
  useEffect(() => {
    if (!settingsHydrated) return;
    setModel(
      resolveModelSelection({
        storedModel: sessionId ? getSessionModel(sessionId) : null,
        agentDefaultModel: agentDefaultModel(chatAgentDefaults),
        catalog: catalogOptions,
        hostDefaultModel,
      })
    );
  }, [
    sessionId,
    catalogOptions,
    hostDefaultModel,
    chatAgentDefaults,
    getSessionModel,
    settingsHydrated,
  ]);

  // Re-read this session's own effort. T25 applies the
  // selected model's capability in the reconciliation effect below once its
  // catalog metadata is known.
  useEffect(() => {
    setEffort(
      resolveEffortSelection(
        sessionId ? getSessionEffort(sessionId) : null,
        agentDefaultEffort(chatAgentDefaults)
      ) ?? EFFORT_DEFAULT_ID
    );
  }, [sessionId, chatAgentDefaults, getSessionEffort]);

  const options = modelOptionsFor(catalogOptions);
  const selectedCatalogModel = catalogOptions.find((option) => option.id === model);
  const availableEfforts = effortsForModel(selectedCatalogModel);

  useEffect(() => {
    if (!settingsHydrated) return;
    const reconciled = reconcileEffortForModel(effort, selectedCatalogModel);
    if (reconciled === effort) return;
    // Store the fallback only on this chat. Catalog reconciliation must never
    // rewrite the defaults used by other conversations.
    setEffort(reconciled);
    if (sessionId) setSessionEffort(sessionId, reconciled);
    else setChatAgentDefaults(withAgentPreference(chatAgentDefaults, { effort: reconciled }));
  }, [
    chatAgentDefaults,
    effort,
    selectedCatalogModel,
    sessionId,
    setChatAgentDefaults,
    setSessionEffort,
    settingsHydrated,
  ]);
  const isAutomatic = model === AUTOMATIC_MODEL_ID;
  // F07: three states, not two. `pending` — nothing has answered yet, or the
  // only answer is a failure — carries NO suffix: during startup the catalog is
  // simply absent, and the old two-state test (membership alone) turned that
  // window into a standing `grok/grok-4.6 · unverified`. Which selection is
  // DISPLAYED is unchanged; only whether this build is willing to make a claim
  // about it moved.
  const verification = modelVerification({
    model,
    catalog: catalogOptions,
    catalogAuthoritative: authoritative,
  });
  // The label the prepended row carries, and the label the TRIGGER carries, are
  // deliberately the same string: a trigger reading `gpt-5.5` next to a menu row
  // reading `gpt-5.5 · unverified` would read as two different selections.
  const unknownLabel = verification === 'unverified' ? unverifiedModelLabel(model) : undefined;
  const modelLabel = isAutomatic
    ? AUTOMATIC_MODEL_LABEL
    : (options.find((option) => option.id === model)?.label ?? unknownLabel ?? model);
  const { base, suffix } = composerModelLabelParts({ modelLabel, effort });
  const menu = composerModelMenuModel({
    options,
    selectedModel: model,
    selectedEffort: effort,
    unknownModelLabel: unknownLabel,
    efforts: availableEfforts,
  });

  const handleSelect = (sectionId: ComposerMenuSection['id'], itemId: string) => {
    if (sectionId === 'model') {
      setModel(itemId);
      // Persist Automatic too: it must not inherit another chat's next pick.
      if (sessionId) {
        setSessionModel(sessionId, itemId);
      }
      const nextModel = catalogOptions.find((option) => option.id === itemId);
      const nextEffort = reconcileEffortForModel(effort, nextModel);
      if (nextEffort !== effort) {
        setEffort(nextEffort);
        if (sessionId) setSessionEffort(sessionId, nextEffort);
      }
      // §4.3: an explicit pick also becomes this agent's template, so the next
      // new draft on the same agent starts where the user left off.
      //
      // The effort half rides along ONLY when this model forced a fallback —
      // otherwise `nextEffort` is just whatever THIS chat was restored with,
      // and writing it would leak one conversation's effort onto every future
      // one (pick a model in a chat running high, and high silently becomes
      // the default). Effort reaches the template from an explicit effort
      // pick, below. What is written here is the illegal-combination fix: a
      // template naming a model that cannot do its own effort would hand the
      // next draft a value the catalog immediately reconciles away.
      setChatAgentDefaults(
        withAgentPreference(chatAgentDefaults, {
          model: itemId === AUTOMATIC_MODEL_ID ? undefined : itemId,
          ...(nextEffort !== effort ? { effort: nextEffort } : {}),
        })
      );
      return;
    }
    setEffort(itemId);
    if (sessionId) setSessionEffort(sessionId, itemId);
    // Written in BOTH cases, with and without a chat: §4.3 already made an
    // explicit pick this agent's template so the next draft starts where the
    // user left off, and with no chat the template is the only place it lands.
    setChatAgentDefaults(withAgentPreference(chatAgentDefaults, { effort: itemId }));
    setOpen(false);
    setModelQuery('');
  };

  // §4.6 防线 ① 连带口径: the two axes do NOT share this sentence. A Codex pick
  // rewrites the thread's standing model until it is changed again [实测
  // 06-probes P1], so per-turn wording would be a false statement about what
  // the control just did — while on Claude every turn restates its options
  // [实测 06-probes P2] and per-turn is the literal truth.
  const scopeHint = t(modelScopeHint());
  const selection = `${base}${suffix ? ` ${suffix}` : ''}`;
  // The trigger shows the effort as a bare value ("High") with no category
  // word, so the accessible name has to supply the category that sighted users
  // read off the menu's own group headings. A screen reader announces this in
  // the UI language, so it goes through the catalog like any other copy.
  const spokenLabel = t('Model and reasoning effort: {{selection}} — {{scope}}', {
    selection,
    scope: scopeHint,
  });
  const title = t('{{selection}} — click to change model or reasoning effort ({{scope}})', {
    selection,
    scope: scopeHint,
  });

  return (
    <Menu
      open={open}
      // §4.1 刷新: opening the menu is the one moment a stale list is about to
      // be read, so it is where the TTL is checked. Without it a catalog
      // fetched once is frozen for the life of the renderer process — the hook
      // only re-requests when its `request` identity changes (agent/hostState)
      // and this component is never remounted. `refresh` is the non-forced
      // path: `shouldRequestCatalog` decides, and a fresh proxy entry costs
      // nothing. The menu keeps showing the values it has while it runs, which
      // is what `REFRESHING_CATALOG_NOTICE` is for.
      onOpenChange={(open) => {
        setOpen(open);
        if (open) refresh();
        else setModelQuery('');
      }}
    >
      <MenuPrimitive.Trigger
        className={composerModelTriggerClass()}
        disabled={disabled}
        aria-label={spokenLabel}
        title={title}
        render={<button type="button" />}
      >
        <span className={composerModelBaseClass()}>{base}</span>
        {suffix && <span className={composerModelSuffixClass()}>{suffix}</span>}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuPrimitive.Trigger>
      {/* The shared popup's hairline `::before` derives its radius from the
          popup's own, so overriding one without the other leaves a 15px inner
          stroke inside a 12px frame — visible as a doubled corner. */}
      {/* U30: anchored to the trigger's RIGHT edge, not its left.
          This trigger's width is its content — a model name plus an effort
          suffix — so it changes every time either one changes. It sits in the
          bar's `ms-auto` trailing group, which pins its right edge and lets the
          left edge float; a left-anchored popup therefore jumped sideways
          between `Automatic` and `GPT-5.6 Terra High`, and jumped again while
          the menu was open and a pick changed the label behind it. The right
          edge is the stable one, so the popup hangs off that. */}
      <MenuPopup
        align="end"
        className="min-w-40 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
        side={composerPopupSide(mode)}
      >
        <div className="relative px-1 pb-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
            }}
            placeholder={t('Search models')}
            className="h-7 pl-7"
            aria-label={t('Search models')}
          />
        </div>
        {menu.sections.map((section, index) => (
          <div key={section.id}>
            {index > 0 && <MenuSeparator />}
            <ModelMenuSection
              section={section}
              onSelect={handleSelect}
              query={section.id === 'model' ? modelQuery : ''}
              fallbackGroupLabel={t('Other models')}
            />
          </div>
        ))}
        {/* §4.3-5: catalog provenance is a STATUS row, never a radio item — an
            unreachable or stale catalog has to say so instead of sitting
            silently alongside real entries, which is the one thing the `source`
            discriminant exists to stop. `loading` shows here and nowhere else,
            which is what keeps the menu on its last value instead of a
            spinner. */}
        {status.message && (
          <>
            <MenuSeparator />
            <div className="flex items-center gap-2 px-2 py-1.5 text-meta text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={status.reason ?? undefined}>
                {status.message}
              </span>
              {status.retryable && (
                <button
                  className="shrink-0 rounded-sm px-1 text-ui hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                  disabled={loading}
                  onClick={retry}
                  type="button"
                >
                  Retry
                </button>
              )}
            </div>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
