import { ArrowRightLeft } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { useSettingsIntentStore } from '@/stores/settingsIntent';
import { MODEL_MISSING_ERROR_VIEW } from './modelMissingError';

interface ModelMissingNoticeProps {
  /** The failure text this notice replaces; still printed, so the model id survives. */
  error: string | null | undefined;
  className?: string;
}

/**
 * T062 round-2 (2026-09-17 re-verification) — the model-missing recovery card
 * on the SEND path.
 *
 * H/21 gave this failure three surfaces, and the field run found that none of
 * them can be reached by simply sending into a chat whose model is gone:
 *  - the timeline's session-failed card is gated on `status === 'failed'`, and
 *    the runtime emits `session.status: idle` immediately after
 *    `session.failed` (`agent-loop/index.ts`, `events/projector.ts`), so that
 *    status never survives a render;
 *  - the error-bubble swap needs an `role:'error'` MESSAGE in the transcript,
 *    which only the IPC-level catch writes — a `session.failed` event writes
 *    `lastError` and nothing else;
 *  - the history notice belongs to a failed history read, not to a send.
 *
 * What IS durable on that path is `lastError`, which is what puts the red box
 * above the composer on screen. So the card lives here, driven by the same
 * value, and the box it replaces is kept as the raw diagnostic line below the
 * copy — the sentence names the model, and that is the one part of it a user
 * needs.
 *
 * Every string is a `t()` lookup: `MODEL_MISSING_ERROR_VIEW`'s fields are
 * dictionary KEYS, not display text (see its own header).
 */
export function ModelMissingNotice({ error, className }: ModelMissingNoticeProps) {
  const { t } = useI18n();
  const requestSettings = useSettingsIntentStore((state) => state.requestSettings);

  return (
    <Alert variant="error" className={className}>
      <AlertTitle>{t(MODEL_MISSING_ERROR_VIEW.title)}</AlertTitle>
      <AlertDescription>
        <p>{t(MODEL_MISSING_ERROR_VIEW.message)}</p>
        <p>{t(MODEL_MISSING_ERROR_VIEW.hint)}</p>
        {error && (
          <p className="max-h-20 select-text overflow-auto break-all whitespace-pre-wrap font-mono text-code">
            {error}
          </p>
        )}
      </AlertDescription>
      <AlertAction>
        <Button
          size="xs"
          variant="outline"
          className="h-6"
          onClick={() => requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)}
        >
          <ArrowRightLeft />
          {t(MODEL_MISSING_ERROR_VIEW.actionLabel)}
        </Button>
      </AlertAction>
    </Alert>
  );
}
