import { MessagesSquare } from 'lucide-react';
import { useI18n } from '@/i18n';

/**
 * The screen above the composer whenever a conversation has not started yet.
 *
 * ## What it used to be, and why that changed twice
 *
 * T12-e made it the "no repository registered" surface, replacing a red
 * monospace box that read like a crash on a fresh install. U05-b stopped it
 * REPLACING the composer, so a folderless user could still type. U22 added a
 * "just start chatting" button to it, because the composer below was still
 * disabled without a session.
 *
 * U28 removes that button and the guidance around it. Two things drove it:
 *
 *  1. The button was a workaround for the real gate. `canSend` required a
 *     session; the honest fix was to let the first send CREATE one, which is
 *     what `runSend` now does — so there is nothing left for a button to do.
 *  2. The user compared this screen with pix's and called ours 「臃肿浮夸」.
 *     pix shows a mark, a line, and a sentence, with a live composer beneath.
 *     Everything else here — a menu button duplicating the composer's own
 *     target bar, a paragraph explaining a choice the user had not asked
 *     about — was instruction where a working input would do.
 *
 * ## Why it now shows on EVERY start, not just a folderless one
 *
 * The user asked for it (2026-09-06): a bound chat that has not started yet is
 * the same moment as an unbound one — an empty column above an empty composer.
 * Only the sentence differs, and it differs by naming the folder the agent will
 * work in, which is the one fact worth stating before the first message.
 */
interface ChatWelcomeCardProps {
  /**
   * The folder this chat will run in, when it has one. Absent means the chat
   * is unbound and will get a private scratch directory on its first send.
   */
  workspaceName?: string;
}

export function ChatWelcomeCard({ workspaceName }: ChatWelcomeCardProps) {
  const { t } = useI18n();

  return (
    <div className="mb-6 flex flex-col items-center gap-3 text-center">
      {/* A mark, not an illustration: it carries no information, so it gets the
          smallest form that still reads as "this is where the app starts". */}
      <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <MessagesSquare className="size-6" />
      </div>
      <h2 className="font-semibold text-foreground text-title">{t('Start a conversation')}</h2>
      {/* `text-meta` rather than a raw size: D25 §6.3 bans raw size utilities
          in chat/, and this is a secondary line. */}
      <p className="max-w-sm text-meta text-muted-foreground">
        {workspaceName
          ? t('The agent will work inside {{folder}} — type what you want done.', {
              folder: workspaceName,
            })
          : t('Just type. This chat runs in a private temporary folder.')}
      </p>
    </div>
  );
}
