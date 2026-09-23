import { CirclePause, Send } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface TurnCeilingNoticeProps {
  /** Carries on from the pause: sends a plain "continue", never the original prompt. */
  onContinue: () => void;
}

/**
 * decision 040 — the run reached the interactive turn ceiling, wrote its
 * wrap-up summary and paused.
 *
 * Neutral on purpose (`default`, not `error`): nothing failed. The summary the
 * model just wrote says where things stand; this says WHY the run stopped
 * there and offers the one-click way on. The ceiling's number is deliberately
 * not repeated here — the runtime owns it, and a second copy in the renderer
 * is the drift decision 039's audit note (loop-model-13) was about.
 */
export function TurnCeilingNotice({ onContinue }: TurnCeilingNoticeProps) {
  const { t } = useI18n();
  return (
    <Alert variant="default" role="status">
      <CirclePause />
      <AlertTitle className="min-w-0 truncate">{t('Paused at the turn ceiling')}</AlertTitle>
      <AlertDescription className="text-meta">
        <p className="break-words">
          {t(
            'This run reached the turn ceiling for one request, so the assistant summarised its progress and paused. The work so far is kept.'
          )}
        </p>
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" className="h-6" onClick={onContinue}>
          <Send />
          {t('Continue')}
        </Button>
      </AlertAction>
    </Alert>
  );
}
