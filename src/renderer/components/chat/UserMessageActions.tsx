import { PencilLine, Split } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { materializeForkedChatSession } from '@/stores/chatSessionActions';
import { type ChatMessage, statusForNextTurn, useChatSessionsStore } from '@/stores/chatSessions';
import { useComposerDraftsStore } from '@/stores/composerDrafts';
import { resetSessionScopedRendererState } from '@/stores/sessionLifecycle';
import { CopyIconButton } from './CopyIconButton';
import { userMessageActionRowClass } from './chatTimelineLayout';
import { requestComposerFocus } from './composerFocus';
import {
  runWithSessionStarted,
  SESSION_STOPPED_BEFORE_RUN,
  sessionStartFailureKey,
} from './sessionStart';
import { sessionStartEffects } from './sessionStartDeps';
import {
  type PromptActionDeps,
  runEditAndResend,
  runForkFromPrompt,
  userMessageActionFailure,
  userMessageActions,
  userMessageCopyText,
} from './userMessageActions';

/** A start that did not happen, as the dictionary key it is shown as. */
class StartRefused extends Error {}

function promptActionDeps(sessionId: string): PromptActionDeps {
  return {
    afterStart: async (operation) => {
      const result = await runWithSessionStarted({ sessionId, operation, ...sessionStartEffects });
      if (result.kind === 'not-started') {
        throw new StartRefused(sessionStartFailureKey(result.start));
      }
      if (result.kind === 'cancelled') throw new StartRefused(SESSION_STOPPED_BEFORE_RUN);
      return result.value;
    },
    getSessionTree: (id) =>
      window.electronAPI.chat.getSessionTree({ sessionId: id, requestSequence: Date.now() }),
    rewindSession: (id, entryId) =>
      window.electronAPI.chat.rewindSession({ sessionId: id, entryId, confirmed: true }),
    forkSession: (id, entryId) => window.electronAPI.chat.forkSession({ sessionId: id, entryId }),
    resetSession: resetSessionScopedRendererState,
    offerText: (id, text) => useComposerDraftsStore.getState().offerText(id, text),
    focusComposer: requestComposerFocus,
    materializeFork: (session) =>
      materializeForkedChatSession(session as Parameters<typeof materializeForkedChatSession>[0]),
  };
}

/**
 * Issue #26 item 1: copy / edit & resend / fork from here, a frameless row of
 * ghost icon buttons under the user's bubble (the reference's MessageActions).
 *
 * Revealed by hovering the message (`group/user` on its row) or by keyboard
 * focus; the row reserves its 24px at all times, so the reveal never moves the
 * page (the turn action strip's ruling, `turnActionsSlotClass`).
 */
export function UserMessageActions({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const sessionId = message.sessionId;
  const facts = useChatSessionsStore(
    useShallow((state) => {
      const session = state.sessions.find((item) => item.id === sessionId);
      return {
        engine: session?.engine,
        durable: session?.runtimeIdentity != null,
        idle: (statusForNextTurn(session) ?? 'idle') === 'idle',
      };
    })
  );
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const actions = userMessageActions({
    engine: facts.engine,
    hasDurableSession: facts.durable,
    idle: facts.idle,
    pending: false,
  });
  const disabled = !facts.idle || pending;

  const run = async (action: typeof runEditAndResend, failureTitle: string): Promise<void> => {
    setPending(true);
    try {
      const timeline = useChatSessionsStore.getState().messages[sessionId] ?? [];
      await action(promptActionDeps(sessionId), sessionId, message, timeline);
    } catch (cause) {
      const failure =
        cause instanceof StartRefused
          ? { text: cause.message, translated: true }
          : userMessageActionFailure(cause);
      toastManager.add({
        type: 'error',
        title: failureTitle,
        description: failure.translated ? t(failure.text) : failure.text,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={userMessageActionRowClass()} data-testid="user-message-actions">
      <CopyIconButton
        text={userMessageCopyText(message)}
        label={t('Copy message')}
        copiedLabel={t('Copied')}
      />
      {actions.edit && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={t('Edit and resend')}
          title={t('Edit and resend')}
          onClick={() => setConfirming(true)}
        >
          <PencilLine className="size-3.5" />
        </Button>
      )}
      {actions.fork && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={t('Fork from here')}
          title={t('Fork from here')}
          onClick={() => void run(runForkFromPrompt, t('Could not fork from this message'))}
        >
          <Split className="size-3.5" />
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Edit and resend this message?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'The conversation goes back to before this message and its text returns to the input box. Later messages stay in the session branches; nothing is deleted.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                void run(runEditAndResend, t('Could not go back to this message'));
              }}
            >
              <PencilLine />
              {t('Edit and resend')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
