import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { userBubbleActionClass } from './chatTimelineLayout';
import { withdrawInterjection } from './interjectionWithdraw';

/**
 * GitHub issue #8 (dsh-rebase decision 172 §4): 「撤回」 on the status line of
 * a Ctrl+Enter message awaiting delivery.
 *
 * Always on screen while the message can still be withdrawn, not revealed on
 * hover like the turn's copy button: it is the one thing the user can do with
 * the bubble, and only until the step it waits for ends. A real button, in the
 * tab order, read aloud as 「撤回这条消息」 (the visible word and its object).
 *
 * Once it cannot be withdrawn — a turn took it in first, or the engine
 * connection it went to is gone — the button gives way to a muted 「无法撤回」
 * whose reason is its tooltip. Not a disabled button: that would leave the tab
 * order and show no tooltip, so the reason would be out of reach.
 */
export function InterjectionWithdrawControl({
  sessionId,
  attemptId,
}: {
  sessionId: string;
  attemptId: string;
}) {
  const { t } = useI18n();
  const withdrawal = usePendingUserMessagesStore(
    (state) =>
      state.bySession[sessionId]?.find((message) => message.attemptId === attemptId)?.withdrawal
  );

  if (withdrawal === 'delivered' || withdrawal === 'unavailable') {
    const reason =
      withdrawal === 'delivered'
        ? t('Already delivered; it can no longer be withdrawn')
        : t(
            'The engine can no longer find it: the connection was re-established, or the chat was rewound, after it was sent'
          );
    return (
      <>
        <span aria-hidden>·</span>
        <span title={reason}>{t('Cannot withdraw')}</span>
      </>
    );
  }

  const withdrawing = withdrawal === 'pending';
  const run = async () => {
    const result = await withdrawInterjection(sessionId, attemptId);
    // `withdrawn` says itself: the bubble goes and the words are back in the box.
    if (result.outcome === 'delivered') {
      toastManager.add({
        type: 'info',
        title: t('Already delivered; it can no longer be withdrawn'),
      });
    } else if (result.outcome === 'not_found') {
      toastManager.add({
        type: 'info',
        title: t('This message can no longer be withdrawn'),
        description: t(
          'The engine can no longer find it: the connection was re-established, or the chat was rewound, after it was sent'
        ),
      });
    } else if (result.outcome === 'failed') {
      toastManager.add({
        type: 'error',
        title: t('Could not withdraw the message'),
        description: result.error,
      });
    }
  };
  return (
    <Button
      size="xs"
      variant="ghost"
      className={userBubbleActionClass()}
      disabled={withdrawing}
      aria-label={t('Withdraw this message')}
      title={t('Take it back before it is delivered; it goes back to the message box')}
      onClick={() => void run()}
    >
      {withdrawing ? <Spinner className="size-3.5" /> : <Undo2 className="size-3.5" />}
      {t('Withdraw')}
    </Button>
  );
}
