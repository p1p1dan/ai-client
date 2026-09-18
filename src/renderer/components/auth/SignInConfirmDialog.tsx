import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import type { SignInPromptKind } from '@/stores/signInConfirm';
import { type SignInLossSnapshot, signInLossLines } from './signInLossModel';

/**
 * "Here is what going to the sign-in screen costs you."
 *
 * ## Why `AlertDialog` and not `Dialog`
 *
 * `UnsavedChangesDialog` — the closest thing this repo already has to this
 * prompt ("your changes will be lost if you don't save them") — is an
 * `AlertDialog`, and for the reason that matters here: Base UI's alert dialog
 * does not close on an outside click or a stray Escape. A confirmation whose
 * "yes" kills running processes must be answered, not dismissed by accident.
 * (`UserProfileCard`'s logout confirm is a plain `Dialog`; that one only ever
 * asked a question, it did not stand between the user and their work.)
 *
 * `zIndexLevel` stays at its `base` default on purpose. Every caller sits in
 * the page or, for the account card, inside a `Popover` — `Z_INDEX.DROPDOWN`
 * (40), below `MODAL_BACKDROP` (50). None of them is inside another modal, so
 * `nested` (70/71) would only lift this above dialogs it never coexists with.
 */

export interface SignInConfirmDialogProps {
  open: boolean;
  kind: SignInPromptKind;
  snapshot: SignInLossSnapshot;
  /** `true` = go ahead and sign in; `false` = change nothing at all. */
  onAnswer: (granted: boolean) => void;
}

export function SignInConfirmDialog({ open, kind, snapshot, onAnswer }: SignInConfirmDialogProps) {
  const { t } = useI18n();
  const expired = kind === 'session-expired';
  const lines = signInLossLines(snapshot);

  return (
    <AlertDialog
      open={open}
      // Base UI still routes a programmatic close through here; anything that
      // is not an explicit "yes" means "change nothing".
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onAnswer(false);
      }}
    >
      <AlertDialogPopup className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {/* `text-warning`, the semantic token — `docs/design-system.md`
                asks for CSS variables over raw palette steps. (The older
                `UnsavedChangesDialog` still hardcodes `text-yellow-500`; this
                is not copying that.) */}
            <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">
              {expired
                ? t('Your sign-in has expired — you need to sign in again')
                : t('Going to the sign-in screen closes this workspace')}
            </span>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {expired
              ? t(
                  'AI features have already stopped working. Returning to the sign-in screen closes the workspace you have open.'
                )
              : t(
                  'The app goes back to the welcome screen, so the workspace you have open is closed.'
                )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 px-6">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-foreground">
            {lines.map((line) => (
              <li key={line.key}>{t(line.key, line.params)}</li>
            ))}
          </ul>
          {/* The narrow, true reassurance. "Your chats are unaffected" was the
              tempting one and it does not survive checking (see
              `signInLossModel.ts`): the turn survives, the renderer's view of
              it does not. What IS safe is everything already on screen — the
              store is a module singleton and the transcript is on disk — so
              that is what the line claims, and nothing more.

              The unsent draft is named here rather than counted: it lives in
              `ChatComposer`'s own `useState`, so there is no number to read,
              and it really does go. */}
          <p className="text-xs text-muted-foreground">
            {t(
              'Chat history is safe. Anything you typed into the composer but have not sent is not.'
            )}
          </p>
        </div>

        <AlertDialogFooter variant="bare">
          <Button variant="outline" onClick={() => onAnswer(false)}>
            {/* An expired session is not something the user chose, so the way
                out is "not now" rather than "cancel" — and it has to exist, or
                a forced sign-out would take unsaved work with it. The account
                chip in the footer keeps showing 登录已过期, which is how they
                come back to this. */}
            {expired ? t('Not now') : t('Cancel')}
          </Button>
          <Button variant="destructive" onClick={() => onAnswer(true)}>
            {expired ? t('Sign in again') : t('Continue to sign-in')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
