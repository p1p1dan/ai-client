import { useEffect, useState } from 'react';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { defaultModelId, ensureModelOptions } from './models';
import { useSessionModel } from './useSessionModel';

/**
 * Composer model selector (T-08): short-name dropdown bound per-session.
 *
 * The selected id persists via `useSessionModel` and flows into
 * `createSession({ model })` on Send (Composer reads `getSessionModel`).
 * Host-reported default from `host.ready.settings.model` may arrive later;
 * if so it overrides the initial default but never overrides an explicit
 * user selection already recorded for this session.
 */

interface ModelSelectProps {
  sessionId: string;
  /** Host-reported default model id from `host.ready.settings.model`, if seen. */
  hostDefaultModel?: string | null;
  disabled?: boolean;
}

export function ModelSelect({ sessionId, hostDefaultModel, disabled }: ModelSelectProps) {
  const { getSessionModel, setSessionModel } = useSessionModel();
  const [selected, setSelected] = useState<string>(() => {
    const stored = getSessionModel(sessionId);
    if (stored) return stored;
    return defaultModelId(hostDefaultModel);
  });

  // Session switched or Host reported a default late: keep an explicit stored
  // selection, otherwise adopt the new default.
  useEffect(() => {
    const stored = getSessionModel(sessionId);
    if (stored) {
      setSelected(stored);
      return;
    }
    if (hostDefaultModel) {
      setSelected(defaultModelId(hostDefaultModel));
    }
  }, [sessionId, hostDefaultModel, getSessionModel]);

  const options = ensureModelOptions(hostDefaultModel);
  const selectedLabel = options.find((option) => option.id === selected)?.label ?? selected;

  const handleChange = (value: string | null) => {
    if (!value) return;
    setSelected(value);
    setSessionModel(sessionId, value);
  };

  return (
    <Select value={selected} onValueChange={handleChange} disabled={disabled}>
      {/* Round-2 visual fix: `size="sm"` still leaves `min-h-8`/`sm:min-h-7`
          in the merged class list (different tailwind-merge group from
          `height`), so the trigger rendered 28px instead of the intended
          24px `h-6` token shared with its row siblings (TargetBranchSelect,
          RunLocationIndicator). `min-h-6 sm:min-h-6` reasserts both groups.
          `min-w-26` (6.5rem, token-scale — matches `w-70` elsewhere in this
          file, not a bracket-arbitrary literal) keeps the prior width. */}
      <SelectTrigger
        size="sm"
        className="h-6 min-h-6 sm:min-h-6 w-auto min-w-26 gap-1 px-2 text-xs"
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
