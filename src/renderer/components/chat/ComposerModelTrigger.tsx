import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { composerModelLabelParts, composerModelMenuModel } from './composerModel';
import { EFFORT_DEFAULT_ID, isEffortLevel } from './efforts';
import type { MiddleColumnMode } from './middleColumnLayout';
import {
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
} from './middleColumnLayout';
import { defaultModelId, ensureModelOptions } from './models';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

/**
 * Merged model + reasoning-effort control (T-30b2 拍板 ①, replaces the
 * ModelSelect/EffortSelect pair): one naked `Sonnet High ⌄` trigger, one
 * Base UI Menu with two radio groups. Persistence contracts are unchanged —
 * model via `useSessionModel`, effort via `useSessionEffort`, both read by
 * the composer at send time; effort = Default still means "send no effort
 * field at all".
 *
 * The label splits into a muted base + heavier foreground suffix
 * (`composerModelLabelParts`); with effort = Default the suffix segment does
 * not render — the absence mirrors the wire semantics. Because "Effort" as a
 * word only appears inside the menu now, the trigger carries an explicit
 * aria-label/title naming both settings (the discoverability mitigation the
 * spec requires).
 */

interface ComposerModelTriggerProps {
  sessionId: string;
  /** Host-reported default model id from `host.ready.settings.model`, if seen. */
  hostDefaultModel?: string | null;
  disabled?: boolean;
  /** Popup opens upward from the docked card, downward from the centered one. */
  mode: MiddleColumnMode;
}

export function ComposerModelTrigger({
  sessionId,
  hostDefaultModel,
  disabled,
  mode,
}: ComposerModelTriggerProps) {
  const { getSessionModel, setSessionModel } = useSessionModel();
  const { getSessionEffort, setSessionEffort } = useSessionEffort();

  const [model, setModel] = useState<string>(() => {
    return getSessionModel(sessionId) ?? defaultModelId(hostDefaultModel);
  });
  const [effort, setEffort] = useState<string>(
    () => getSessionEffort(sessionId) ?? EFFORT_DEFAULT_ID
  );

  // Session switched or Host reported a default late: keep an explicit stored
  // selection, otherwise adopt the new default (unchanged ModelSelect logic).
  useEffect(() => {
    const stored = getSessionModel(sessionId);
    if (stored) {
      setModel(stored);
      return;
    }
    if (hostDefaultModel) {
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
  const [modelSection, effortSection] = menu.sections;
  // Radio value must be a real member — garbage storage falls back to Default.
  const effortValue = isEffortLevel(effort) ? effort : EFFORT_DEFAULT_ID;
  const fullLabel = suffix ? `${base} ${suffix}` : base;

  const handleModelChange = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    setModel(value);
    setSessionModel(sessionId, value);
  };

  const handleEffortChange = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    setEffort(value);
    setSessionEffort(sessionId, value);
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Model and reasoning effort: ${fullLabel}`}
        className={composerModelTriggerClass()}
        disabled={disabled}
        title={`${fullLabel} — click to change model or reasoning effort`}
      >
        <span className={composerModelBaseClass()}>{base}</span>
        {suffix ? <span className={composerModelSuffixClass()}>{suffix}</span> : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-40" side={mode === 'session' ? 'top' : 'bottom'}>
        <MenuGroup>
          <MenuGroupLabel className="tracking-[0.04em]">
            {modelSection?.label ?? 'Model'}
          </MenuGroupLabel>
          <MenuRadioGroup onValueChange={handleModelChange} value={model}>
            {(modelSection?.items ?? []).map((item) => (
              <MenuRadioItem key={item.id} value={item.id}>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel className="tracking-[0.04em]">
            {effortSection?.label ?? 'Reasoning effort'}
          </MenuGroupLabel>
          <MenuRadioGroup onValueChange={handleEffortChange} value={effortValue}>
            {(effortSection?.items ?? []).map((item) => (
              <MenuRadioItem key={item.id} title={item.hint} value={item.id}>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
