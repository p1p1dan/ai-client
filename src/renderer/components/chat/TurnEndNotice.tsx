import { Info } from 'lucide-react';
import { useMemo } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import type { ChatTurnEnd } from '@/stores/chatSessions';
import { deriveTurnEndNotice } from './turnEndNoticeModel';

/**
 * dsh-rebase P1-7e (problem 7, decision 140): a reopened turn that saved no
 * reply ends on this note — the same `Alert` shell and body class as the
 * interrupted-turn note (`NoticeMessage`), with the failure's raw sentence
 * under it the way the live card printed it. Never a reply, never red: the
 * failure itself is over, and this only says how the turn ended.
 *
 * Design system v2 §7.7: that makes it a notice that asks for nothing, so it
 * is the frameless light row (an icon, the words), not a box. The one case
 * that still explains a failure -- the live end of a turn that just failed --
 * keeps the error `Alert`.
 */
export function TurnEndNotice({
  turnEnd,
  afterWork = false,
  live = false,
}: {
  turnEnd: ChatTurnEnd;
  /** The turn saved something before this note (`turnEndNotesAfterWork`). */
  afterWork?: boolean;
  /**
   * Drawn at the end of a turn that just failed in this window (`liveTurnEnd`):
   * a failure is tinted as one there, since nothing else on the turn says it
   * once the session's card goes.
   */
  live?: boolean;
}) {
  const { t } = useI18n();
  const view = useMemo(() => deriveTurnEndNotice(turnEnd, { afterWork }), [turnEnd, afterWork]);
  const body = (
    <>
      <p className="select-text whitespace-pre-wrap text-chat-body text-foreground">
        {t(view.key, view.reasonKey ? { reason: t(view.reasonKey) } : undefined)}
      </p>
      {/* The engine's sentence is machine text: mono through the D25 primitive. */}
      {view.detail && (
        <p className="mt-1 select-text break-words whitespace-pre-wrap text-muted-foreground">
          <Ident>{view.detail}</Ident>
        </p>
      )}
    </>
  );
  if (live && turnEnd.kind === 'failed') {
    return (
      <Alert variant="error" role="status" data-testid="turn-end-notice">
        <AlertDescription>{body}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div
      className="flex min-w-0 items-start gap-2 text-muted-foreground"
      role="status"
      data-testid="turn-end-notice"
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
