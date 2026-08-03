import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import {
  type ComposerMenuItem,
  type ComposerMenuSection,
  composerModelLabelParts,
  composerModelMenuModel,
} from './composerModel';
import { EFFORT_DEFAULT_ID } from './efforts';
import {
  composerMenuGroupLabelClass,
  composerMenuItemClass,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import { defaultModelId, ensureModelOptions } from './models';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

/**
 * T-30b2: the Composer's single model + reasoning-effort control, replacing
 * the former `ModelSelect` + `EffortSelect` pair.
 *
 * Both selections are still independent and still land in their own
 * per-session store — only the surface merged. The two states this component
 * owns mirror what the two deleted components each owned, including the
 * "session switched, or the Host reported a default late" reconciliation.
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
function ModelMenuSection({
  section,
  onSelect,
}: {
  section: ComposerMenuSection;
  onSelect: (sectionId: ComposerMenuSection['id'], itemId: string) => void;
}) {
  const selectedId = section.items.find((item) => item.selected)?.id ?? null;

  return (
    <MenuGroup>
      <MenuPrimitive.GroupLabel className={composerMenuGroupLabelClass()}>
        {section.label}
      </MenuPrimitive.GroupLabel>
      <MenuRadioGroup
        value={selectedId}
        onValueChange={(value) => {
          if (typeof value === 'string') onSelect(section.id, value);
        }}
      >
        {section.items.map((item: ComposerMenuItem) => (
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
    </MenuGroup>
  );
}

export function ComposerModelTrigger({
  sessionId,
  hostDefaultModel,
  mode,
  disabled,
}: ComposerModelTriggerProps) {
  const { getSessionModel, setSessionModel } = useSessionModel();
  const { getSessionEffort, setSessionEffort } = useSessionEffort();

  const [model, setModel] = useState<string>(() => {
    const stored = getSessionModel(sessionId);
    if (stored) return stored;
    return defaultModelId(hostDefaultModel);
  });
  const [effort, setEffort] = useState<string>(
    () => getSessionEffort(sessionId) ?? EFFORT_DEFAULT_ID
  );

  // Session switched or the Host reported a default late: an explicit stored
  // selection always wins, otherwise adopt the new default.
  useEffect(() => {
    const stored = getSessionModel(sessionId);
    if (stored) {
      setModel(stored);
    } else if (hostDefaultModel) {
      setModel(defaultModelId(hostDefaultModel));
    }
  }, [sessionId, hostDefaultModel, getSessionModel]);

  useEffect(() => {
    setEffort(getSessionEffort(sessionId) ?? EFFORT_DEFAULT_ID);
  }, [sessionId, getSessionEffort]);

  const options = ensureModelOptions(hostDefaultModel);
  const modelLabel = options.find((option) => option.id === model)?.label ?? model;
  const { base, suffix } = composerModelLabelParts({ modelLabel, effort });
  const menu = composerModelMenuModel({
    options,
    selectedModel: model,
    selectedEffort: effort,
  });

  const handleSelect = (sectionId: ComposerMenuSection['id'], itemId: string) => {
    if (sectionId === 'model') {
      setModel(itemId);
      setSessionModel(sessionId, itemId);
      return;
    }
    setEffort(itemId);
    setSessionEffort(sessionId, itemId);
  };

  // The trigger shows the effort as a bare value ("High") with no category
  // word, so the accessible name has to supply the category that sighted users
  // read off the menu's own group headings.
  const spokenLabel = `Model and reasoning effort: ${base}${suffix ? ` ${suffix}` : ''}`;
  const title = `${base}${suffix ? ` ${suffix}` : ''} — click to change model or reasoning effort`;

  return (
    <Menu>
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
        {menu.sections.map((section, index) => (
          <div key={section.id}>
            {index > 0 && <MenuSeparator />}
            <ModelMenuSection section={section} onSelect={handleSelect} />
          </div>
        ))}
      </MenuPopup>
    </Menu>
  );
}
