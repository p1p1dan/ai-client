import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  agentDefaultEffort,
  agentDefaultModel,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { useSettingsStore } from '@/stores/settings';
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
  reconcileModelSelection,
  resolveModelSelection,
  unverifiedModelLabel,
} from './models';
import { catalogModels } from './piModelCatalog';
import { usePiModelCatalog } from './usePiModelCatalog';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

/**
 * T-30b2: the Composer's single model + reasoning-effort control, replacing
 * the former `ModelSelect` + `EffortSelect` pair.
 *
 * D48 S2 rewired what it reads without changing what it is. Three changes:
 *
 *  1. The catalog is the PROXY's, fetched per agent through
 *     `useAgentModelCatalog` and already family-filtered by Main. The three
 *     hard-coded short names are gone, and so is `ensureModelOptions`' rule that
 *     an unrecognised Host default was automatically a legal option.
 *  2. Both selections are keyed by the (session, AGENT) pair. Which models exist
 *     depends on which runtime runs the chat, so one scalar per session would
 *     lose the Claude pick the moment a zero-turn draft visited Codex (§4.3).
 *  3. `hostDefaultModel` is demoted (§4.3-3): it is no longer an initial value
 *     nor a prepended catalog row, only one more source of an unverified
 *     pre-existing value, consulted when there is no catalog at all.
 *
 * The two `useState`s and the reconciliation effect are the same SHAPE as
 * before — a session switch or a late arrival re-resolves the displayed value —
 * but the late arrival is now the catalog rather than the Host default, and the
 * rules for what a late catalog may overwrite live in `reconcileModelSelection`,
 * truth-tabled under the node-env vitest that can never render this file.
 *
 * `Menu` rather than `Select`: a `Select` models ONE value, and this popup
 * holds two orthogonal radio groups. `Menu.RadioGroup` is the primitive that
 * says so, and it is the same family the target-row dropdowns already use —
 * which is where `data-[popup-open]` in the trigger class comes from.
 */

interface ComposerModelTriggerProps {
  sessionId: string;
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
    <MenuRadioGroup
      value={selectedId}
      onValueChange={(value) => {
        if (typeof value === 'string') onSelect(value);
      }}
    >
      {items.map((item) => (
        <MenuPrimitive.RadioItem
          key={item.id}
          value={item.id}
          className={composerMenuItemClass()}
          title={item.hint}
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
  const selectedId = section.items.find((item) => item.selected)?.id ?? null;
  if (section.id === 'model') {
    const direct = section.items.filter(
      (item) => item.id === AUTOMATIC_MODEL_ID || item.verified === false
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
            <MenuSub key={group.id}>
              <MenuSubTrigger className={composerMenuItemClass()}>
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                {selected ? <Check className="size-3.5 shrink-0" /> : null}
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]">
                <MenuRadioRows
                  items={items}
                  selectedId={selectedId}
                  onSelect={(itemId) => onSelect(section.id, itemId)}
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

export function ComposerModelTrigger({
  sessionId,
  hostDefaultModel,
  hostState,
  mode,
  disabled,
}: ComposerModelTriggerProps) {
  const { t } = useI18n();
  const { getSessionModel, setSessionModel, clearSessionModel } = useSessionModel();
  const { getSessionEffort, setSessionEffort } = useSessionEffort();
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const setChatAgentDefaults = useSettingsStore((state) => state.setChatAgentDefaults);

  const { catalog, loaded, loading, status, refresh, retry } = usePiModelCatalog(hostState);
  const catalogOptions = catalogModels(catalog);

  const [model, setModel] = useState<string>(() =>
    resolveModelSelection({
      storedModel: getSessionModel(sessionId),
      agentDefaultModel: agentDefaultModel(chatAgentDefaults),
      catalog: catalogOptions,
      hostDefaultModel,
    })
  );
  const [effort, setEffort] = useState<string>(
    () =>
      resolveEffortSelection(getSessionEffort(sessionId), agentDefaultEffort(chatAgentDefaults)) ??
      EFFORT_DEFAULT_ID
  );
  const [modelQuery, setModelQuery] = useState('');

  // Which (session, agent) the displayed value was resolved for. This component
  // is NEVER remounted per session — `ChatWorkspace` renders one `ChatComposer`
  // with no `key` — so without this ref a session switch is indistinguishable
  // from a re-render, and §4.3-6's two triggers collapse into one.
  const resolvedPairRef = useRef<string>(sessionId);

  // §4.3-6: the session, the agent, or the catalog moved. A pair change
  // re-resolves from that pair's own storage unconditionally (anything else
  // shows the previous session's model while the send path uses the new
  // session's — R11/A11's display≠send split); a catalog that has not landed
  // yet changes nothing at all (that is what "show the last value, never a
  // spinner and never an empty menu" means in state terms); and a catalog that
  // HAS landed may only overwrite a value nobody chose. Every one of those
  // branches is `reconcileModelSelection`'s, not this effect's.
  useEffect(() => {
    const pair = sessionId;
    const pairChanged = resolvedPairRef.current !== pair;
    resolvedPairRef.current = pair;
    setModel((current) =>
      reconcileModelSelection({
        current,
        pairChanged,
        storedModel: getSessionModel(sessionId),
        agentDefaultModel: agentDefaultModel(chatAgentDefaults),
        catalog: catalogOptions,
        catalogLoaded: loaded,
        hostDefaultModel,
      })
    );
  }, [sessionId, catalogOptions, loaded, hostDefaultModel, chatAgentDefaults, getSessionModel]);

  // Session or agent switched: re-read this pair's own effort. T25 applies the
  // selected model's capability in the reconciliation effect below once its
  // catalog metadata is known.
  useEffect(() => {
    setEffort(
      resolveEffortSelection(getSessionEffort(sessionId), agentDefaultEffort(chatAgentDefaults)) ??
        EFFORT_DEFAULT_ID
    );
  }, [sessionId, chatAgentDefaults, getSessionEffort]);

  const options = modelOptionsFor(catalogOptions);
  const selectedCatalogModel = catalogOptions.find((option) => option.id === model);
  const availableEfforts = effortsForModel(selectedCatalogModel);

  useEffect(() => {
    const reconciled = reconcileEffortForModel(effort, selectedCatalogModel);
    if (reconciled === effort) return;
    // Store the explicit Default sentinel on this (session, agent) pair. That
    // outranks an incompatible template, while updating the template itself
    // keeps the next draft from resurrecting the illegal value. The Context
    // mirror and create/send/resume wire read those same two stores.
    setEffort(reconciled);
    setSessionEffort(sessionId, reconciled);
    setChatAgentDefaults(withAgentPreference(chatAgentDefaults, { effort: reconciled }));
  }, [
    chatAgentDefaults,
    effort,
    selectedCatalogModel,
    sessionId,
    setChatAgentDefaults,
    setSessionEffort,
  ]);
  const inCatalog = catalogOptions.some((option) => option.id === model);
  const isAutomatic = model === AUTOMATIC_MODEL_ID;
  // The label the prepended row carries, and the label the TRIGGER carries, are
  // deliberately the same string: a trigger reading `gpt-5.5` next to a menu row
  // reading `gpt-5.5 · unverified` would read as two different selections.
  const unknownLabel = isAutomatic || inCatalog ? undefined : unverifiedModelLabel(model);
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
      // `Automatic` is stored as an ABSENCE, not as a persisted sentinel: it
      // means "omit the field", which is also what an unset pair means, and
      // writing a sentinel would freeze the session against a later agent
      // template. The effort sentinel is stored, because there `Default` and
      // "never chosen" genuinely differ once a template exists.
      if (itemId === AUTOMATIC_MODEL_ID) {
        clearSessionModel(sessionId);
      } else {
        setSessionModel(sessionId, itemId);
      }
      const nextModel = catalogOptions.find((option) => option.id === itemId);
      const nextEffort = reconcileEffortForModel(effort, nextModel);
      if (nextEffort !== effort) {
        setEffort(nextEffort);
        setSessionEffort(sessionId, nextEffort);
      }
      // §4.3: an explicit pick also becomes this agent's template, so the next
      // new draft on the same agent starts where the user left off. T25 updates
      // model and any forced effort fallback in ONE template write.
      setChatAgentDefaults(
        withAgentPreference(chatAgentDefaults, {
          model: itemId === AUTOMATIC_MODEL_ID ? undefined : itemId,
          ...(nextEffort !== effort ? { effort: nextEffort } : {}),
        })
      );
      return;
    }
    setEffort(itemId);
    setSessionEffort(sessionId, itemId);
    setChatAgentDefaults(withAgentPreference(chatAgentDefaults, { effort: itemId }));
  };

  // §4.6 防线 ① 连带口径: the two axes do NOT share this sentence. A Codex pick
  // rewrites the thread's standing model until it is changed again [实测
  // 06-probes P1], so per-turn wording would be a false statement about what
  // the control just did — while on Claude every turn restates its options
  // [实测 06-probes P2] and per-turn is the literal truth.
  const scopeHint = modelScopeHint();
  // The trigger shows the effort as a bare value ("High") with no category
  // word, so the accessible name has to supply the category that sighted users
  // read off the menu's own group headings.
  const spokenLabel = `Model and reasoning effort: ${base}${suffix ? ` ${suffix}` : ''} — ${scopeHint}`;
  const title = `${base}${suffix ? ` ${suffix}` : ''} — click to change model or reasoning effort (${scopeHint})`;

  return (
    <Menu
      // §4.1 刷新: opening the menu is the one moment a stale list is about to
      // be read, so it is where the TTL is checked. Without it a catalog
      // fetched once is frozen for the life of the renderer process — the hook
      // only re-requests when its `request` identity changes (agent/hostState)
      // and this component is never remounted. `refresh` is the non-forced
      // path: `shouldRequestCatalog` decides, and a fresh proxy entry costs
      // nothing. The menu keeps showing the values it has while it runs, which
      // is what `REFRESHING_CATALOG_NOTICE` is for.
      onOpenChange={(open) => {
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
      <MenuPopup
        align="start"
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
        {/* §4.3-5: catalog provenance is a STATUS row, never a radio item — a
            `source:'seed'` list is the built-in table, and offering it silently
            alongside real entries is the one thing the `source` discriminant
            exists to stop. `loading` shows here and nowhere else, which is what
            keeps the menu on its last value instead of a spinner. */}
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
