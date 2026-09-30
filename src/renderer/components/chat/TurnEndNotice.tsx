import { useMemo } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import type { ChatTurnEnd } from '@/stores/chatSessions';
import { deriveTurnEndNotice } from './turnEndNotice';

/**
 * dsh-rebase P1-7e (problem 7, decision 140): a reopened turn that saved no
 * reply ends on this note — the same `Alert` shell and body class as the
 * interrupted-turn note (`NoticeMessage`), with the failure's raw sentence
 * under it the way the live card printed it. Never a reply, never red: the
 * failure itself is over, and this only says how the turn ended.
 */
export function TurnEndNotice({
  turnEnd,
  afterWork = false,
}: {
  turnEnd: ChatTurnEnd;
  /** The turn saved something before this note (`turnEndNotesAfterWork`). */
  afterWork?: boolean;
}) {
  const { t } = useI18n();
  const view = useMemo(() => deriveTurnEndNotice(turnEnd, { afterWork }), [turnEnd, afterWork]);
  return (
    <Alert variant="default" role="status" data-testid="turn-end-notice">
      <AlertDescription>
        <p className="select-text whitespace-pre-wrap text-chat-body text-foreground">
          {t(view.key, view.reasonKey ? { reason: t(view.reasonKey) } : undefined)}
        </p>
        {/* The engine's sentence is machine text: mono through the D25 primitive. */}
        {view.detail && (
          <p className="mt-1 select-text break-words whitespace-pre-wrap text-muted-foreground">
            <Ident>{view.detail}</Ident>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
