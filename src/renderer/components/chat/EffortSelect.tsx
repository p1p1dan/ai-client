import { useEffect, useState } from 'react';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CHAT_EFFORTS, EFFORT_DEFAULT_ID, effortLabel } from './efforts';
import { useSessionEffort } from './useSessionEffort';

/**
 * Composer reasoning-effort selector (T-20), bound per-session.
 *
 * The selection persists via `useSessionEffort` and flows into
 * `createSession({ effort })` on Send (Composer reads `getSessionEffort` and
 * passes it through `toWireEffort`). Mirrors `ModelSelect` (T-08) so the two
 * Composer dropdowns behave identically.
 *
 * "Default" is a distinct choice, not a synonym for High: it sends no `effort`
 * field at all, leaving the model default in force (and matching pre-T-20
 * behavior). Protocol base landed with #8; the Host drops unknown levels.
 */

interface EffortSelectProps {
  sessionId: string;
  disabled?: boolean;
}

export function EffortSelect({ sessionId, disabled }: EffortSelectProps) {
  const { getSessionEffort, setSessionEffort } = useSessionEffort();
  const [selected, setSelected] = useState<string>(
    () => getSessionEffort(sessionId) ?? EFFORT_DEFAULT_ID
  );

  // Session switched: adopt that session's stored selection (or the default).
  useEffect(() => {
    setSelected(getSessionEffort(sessionId) ?? EFFORT_DEFAULT_ID);
  }, [sessionId, getSessionEffort]);

  const handleChange = (value: string | null) => {
    if (!value) return;
    setSelected(value);
    setSessionEffort(sessionId, value);
  };

  return (
    <Select value={selected} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className="h-6 w-auto min-w-[5.5rem] gap-1 px-2 text-xs"
        title="Reasoning effort"
      >
        <SelectValue>{effortLabel(selected)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={EFFORT_DEFAULT_ID}>Default</SelectItem>
        {CHAT_EFFORTS.map((effort) => (
          <SelectItem key={effort.id} value={effort.id} title={effort.hint}>
            {effort.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
