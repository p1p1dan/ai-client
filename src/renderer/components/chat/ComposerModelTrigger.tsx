import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  agentDefaultEffort,
  agentDefaultModel,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
import { toastManager } from '@/components/ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { formatAbsoluteDateTime } from '@/lib/relativeTime';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { type ModelMenuRequest, useModelMenuIntentStore } from '@/stores/modelMenuIntent';
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
  LOCKED_MODEL_HINT,
  modelCatalogForEngine,
  modelMenuOptionsFor,
  modelScopeHint,
  modelVerification,
  resolveModelSelection,
  seedDefaultModel,
  unverifiedModelLabel,
} from './models';
import { catalogModels, unavailableModelsNotice } from './piModelCatalog';
import { captureSessionGenerationPreferences } from './sessionGenerationPreferences';
import { resolveEffortCommand, resolveModelCommand } from './slashModelCommand';
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
      {items.map((item) => {
        const row = (
          <MenuPrimitive.RadioItem
            key={item.id}
            value={item.id}
            disabled={item.disabled}
            className={composerMenuItemClass()}
            title={item.disabled ? undefined : item.hint}
            closeOnClick={false}
            onClick={() => {
              if (!item.disabled) onSelect(item.id);
            }}
          >
            {item.description || item.warning ? (
              // Issue #26 item 4: an effort row says what it does on its own
              // lines (it used to be a tooltip), the costly ones warn faintly.
              <span className="flex min-w-0 flex-1 flex-col py-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate" data-slot="menu-row-label">
                    {item.label}
                  </span>
                  {item.badge && (
                    <Badge variant="secondary" data-slot="effort-default-badge">
                      {item.badge}
                    </Badge>
                  )}
                </span>
                {item.description && (
                  <span className="text-small text-muted-foreground">{item.description}</span>
                )}
                {item.warning && (
                  <span className="text-small text-foreground-faint">{item.warning}</span>
                )}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate" data-slot="menu-row-label">
                {item.label}
              </span>
            )}
            <MenuPrimitive.RadioItemIndicator className="shrink-0">
              <Check className="size-3.5" />
            </MenuPrimitive.RadioItemIndicator>
          </MenuPrimitive.RadioItem>
        );
        if (!item.disabled || !item.hint) return row;
        // S-6 feedback 3: a disabled row takes no pointer events, so the hint
        // hangs on a wrapper that does.
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger render={<div data-slot="locked-model-row" />}>{row}</TooltipTrigger>
            {/* Decision 174: 14px, the hint is CJK and coss's popup is 12px. */}
            <TooltipPopup className="max-w-80 text-small">{item.hint}</TooltipPopup>
          </Tooltip>
        );
      })}
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
              <MenuSubPopup className="min-w-52">
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

  const { catalog, authoritative, loading, status, staleness, refresh, retry } =
    usePiModelCatalog(hostState);
  const catalogOptions = catalogModels(catalog);
  const unavailableNotice = unavailableModelsNotice(catalog, t);
  // Route B, S-1 (decision 5): a chat on the Claude engine can switch only to
  // the models of its own route; S-6 feedback 3 lists the others greyed out
  // (`modelMenuOptionsFor`). Selection and effort still read the whole
  // catalog: what is stored is never rewritten here, and a stored model this
  // chat cannot switch to shows as an unverified leftover.
  const engine = useChatSessionsStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.engine : undefined
  );
  const engineRoute = useChatSessionsStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.engineRoute : undefined
  );
  const offeredCatalog = modelCatalogForEngine(catalogOptions, { engine, engineRoute });

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

  // Issue #18: a fresh install has no default model, and the menu no longer offers
  // `Automatic`; seed the template with the catalog's first model (the plan's own
  // default) so the trigger names a model and the next send carries the same one. A
  // session's own stored choice, `Automatic` included, is left as it is.
  useEffect(() => {
    if (!settingsHydrated) return;
    const seed = seedDefaultModel({
      agentDefaultModel: agentDefaultModel(chatAgentDefaults),
      catalog: catalogOptions,
      catalogAuthoritative: authoritative,
    });
    if (seed) setChatAgentDefaults(withAgentPreference(chatAgentDefaults, { model: seed }));
  }, [settingsHydrated, chatAgentDefaults, catalogOptions, authoritative, setChatAgentDefaults]);

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

  const options = modelMenuOptionsFor(catalogOptions, { engine, engineRoute });
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
    catalog: offeredCatalog,
    catalogAuthoritative: authoritative,
  });
  // The label the prepended row carries, and the label the TRIGGER carries, are
  // deliberately the same string: a trigger reading `gpt-5.5` next to a menu row
  // reading `gpt-5.5 · unverified` would read as two different selections.
  const unknownLabel = verification === 'unverified' ? unverifiedModelLabel(model) : undefined;
  // Decision 144: `Automatic` and the effort words are catalog keys; a model's
  // own label is a name and stays as it is.
  const modelLabel = isAutomatic
    ? t(AUTOMATIC_MODEL_LABEL)
    : (options.find((option) => option.id === model && !option.locked)?.label ??
      unknownLabel ??
      model);
  const { base, suffix } = composerModelLabelParts({ modelLabel, effort }, t);
  const menu = composerModelMenuModel({
    options,
    selectedModel: model,
    selectedEffort: effort,
    unknownModelLabel: unknownLabel,
    efforts: availableEfforts,
    lockedModelHint: t(LOCKED_MODEL_HINT),
    t,
  });

  const handleSelect = (sectionId: ComposerMenuSection['id'], itemId: string) => {
    if (sectionId === 'model') {
      // The row is disabled already; a locked model never becomes the selection.
      if (options.some((option) => option.id === itemId && option.locked)) return;
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

  // Decision 194 Q2: `/model` and `/effort` typed in this composer go through the menu
  // itself, so the pick follows the same rules (locked rows, effort fallback, template).
  const handleMenuRequest = (request: ModelMenuRequest) => {
    if (request.kind === 'model') {
      const resolution = resolveModelCommand(request.query, options);
      if (resolution.kind === 'pick') {
        handleSelect('model', resolution.id);
        const label = options.find((option) => option.id === resolution.id)?.label ?? resolution.id;
        toastManager.add({ type: 'info', title: t('Model: {{model}}', { model: label }) });
        return;
      }
      if (resolution.kind === 'locked') {
        toastManager.add({ type: 'info', title: t(LOCKED_MODEL_HINT) });
        return;
      }
      if (resolution.kind === 'unknown') {
        setModelQuery(resolution.query);
        toastManager.add({
          type: 'info',
          title: t('No model is called {{query}}. Pick one from the menu.', {
            query: resolution.query,
          }),
        });
      }
      setOpen(true);
      return;
    }
    const resolution = resolveEffortCommand(
      request.query,
      [{ id: EFFORT_DEFAULT_ID, label: 'Default' }, ...availableEfforts],
      t
    );
    if (resolution.kind === 'pick') {
      handleSelect('effort', resolution.id);
      const label =
        resolution.id === EFFORT_DEFAULT_ID
          ? 'Default'
          : (availableEfforts.find((effort) => effort.id === resolution.id)?.label ??
            resolution.id);
      toastManager.add({
        type: 'info',
        title: t('Reasoning effort: {{effort}}', { effort: t(label) }),
      });
      return;
    }
    if (resolution.kind === 'unknown') {
      toastManager.add({
        type: 'info',
        title: t('This model has no reasoning effort {{query}}. Pick one from the menu.', {
          query: resolution.query,
        }),
      });
    }
    setOpen(true);
  };
  const handleMenuRequestRef = useRef(handleMenuRequest);
  handleMenuRequestRef.current = handleMenuRequest;
  const pendingMenuRequest = useModelMenuIntentStore((state) => state.pending);
  useEffect(() => {
    if (!pendingMenuRequest || pendingMenuRequest.sessionId !== sessionId) return;
    useModelMenuIntentStore.getState().clear(pendingMenuRequest.seq);
    handleMenuRequestRef.current(pendingMenuRequest);
  }, [pendingMenuRequest, sessionId]);

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
  // Issue #12: the trigger's own mark that the list is a fallback. Only when
  // there is a sentence to read about it — an `unavailable` catalog says so in
  // the menu AND here, while a fresh one says nothing in either place.
  const staleList = status.message !== null && staleness !== null;

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
        {/* Issue #12: the list behind this menu may be a fallback, and the user
            has to be able to see that WITHOUT opening it. The menu's own status
            row carries the full sentence and the Retry; this is the sign that
            there is one to read, next to the control it is about. `aria-hidden`
            because the trigger's accessible name already carries the sentence
            through `spokenLabel` below. */}
        {staleList && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
            title={t(status.message ?? '')}
          />
        )}
        <ChevronDown className="size-3.5 shrink-0" />
      </MenuPrimitive.Trigger>
      {/* U30: anchored to the trigger's RIGHT edge, not its left.
          This trigger's width is its content — a model name plus an effort
          suffix — so it changes every time either one changes. It sits in the
          bar's `ms-auto` trailing group, which pins its right edge and lets the
          left edge float; a left-anchored popup therefore jumped sideways
          between `Automatic` and `GPT-5.6 Terra High`, and jumped again while
          the menu was open and a pick changed the label behind it. The right
          edge is the stable one, so the popup hangs off that. */}
      <MenuPopup align="end" className="min-w-40 max-w-80" side={composerPopupSide(mode)}>
        {/* Decision 167 (issue #3 item 5): the search field, input FIRST and
            the icon after it in source (`order-first` draws it on the left).
            Design system v2 §1 rule 1: inside the menu's frame the field has
            no frame of its own -- one hairline divides it from the list. */}
        <div className="-mx-1 mb-1 flex h-8 items-center gap-1.5 border-border-soft border-b px-2.5">
          <Input
            unstyled
            className="min-w-0 flex-1 text-ui [&_input]:h-7 [&_input]:px-0 [&_input]:leading-7"
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
            }}
            placeholder={t('Search models')}
            aria-label={t('Search models')}
          />
          <Search className="order-first size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
            <div className="flex items-center gap-2 px-2 py-1.5 text-small text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={status.reason ?? undefined}>
                {/* A catalog key (`piModelCatalog.ts`'s notices). */}
                {t(status.message)}
                {/* Issue #12: "out of date" is only actionable once the user can
                    judge HOW out of date, so the fallback's own timestamp goes
                    beside the sentence. Absent for the shipped baseline, which
                    was never fetched by this machine and so has no such time. */}
                {staleness?.since ? (
                  <>
                    {' '}
                    {t('Last successful sync: {{time}}', {
                      time: formatAbsoluteDateTime(staleness.since),
                    })}
                  </>
                ) : null}
              </span>
              {status.retryable && (
                <button
                  className="shrink-0 rounded-xs px-1.5 text-ui text-foreground transition-colors duration-150 hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover focus-ring"
                  disabled={loading}
                  onClick={retry}
                  type="button"
                >
                  {t('Retry')}
                </button>
              )}
            </div>
          </>
        )}
        {/* dsh-rebase P1-5a (decision 036): models the engine cannot serve are
            left out of the list above, and counted here instead of vanishing. */}
        {unavailableNotice && (
          <>
            <MenuSeparator />
            <div className="flex items-center gap-2 px-2 py-1.5 text-small text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={unavailableNotice.title}>
                {unavailableNotice.message}
              </span>
            </div>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
