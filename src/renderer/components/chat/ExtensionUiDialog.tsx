import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { useExtensionUiStore } from '@/stores/extensionUi';
import {
  currentExtensionUiDialog,
  type ExtensionUiPendingDialog,
  splitExtensionUiDialogText,
} from './extensionUiModel';

/**
 * T08 — the Portable UI primitives: select / confirm / input / editor.
 *
 * A pi extension calling `ui.select(...)` is BLOCKED on this dialog — its turn
 * does not advance until the user answers or the Host's bridge times it out. Two
 * consequences shape everything below:
 *
 *  1. **Dismissal is an answer.** Escape, the backdrop and Cancel all send
 *     `ok: false`, which makes the Host substitute the fallback recorded when
 *     the dialog opened (`false` for a confirm, `undefined` for the rest). The
 *     renderer never picks that value itself — it only says "nobody answered".
 *  2. **The dialog can vanish underneath the user.** `extensionUi.cancelled`
 *     removes it from the store, and this component follows. A modal that stayed
 *     up after the extension stopped waiting would be a button that does nothing.
 *
 * `@gotgenes/pi-permission-system` asks for tool approval through this exact
 * component (T08-b) — the permission prompt IS a `ui.select` with Yes / Yes for
 * session / No / No with reason.
 */
export function ExtensionUiDialog() {
  const pending = useExtensionUiStore((state) => state.pending);
  const dialog = currentExtensionUiDialog({ pending });

  // Keyed remount: `input` and `editor` hold draft text, and without a fresh
  // mount per request the next dialog would open pre-filled with the previous
  // one's answer.
  return dialog ? (
    <ExtensionUiDialogBody
      key={dialog.uiRequestId}
      pending={dialog}
      position={1}
      total={pending.length}
    />
  ) : null;
}

function ExtensionUiDialogBody({
  pending,
  position,
  total,
}: {
  pending: ExtensionUiPendingDialog;
  position: number;
  total: number;
}) {
  const { t } = useI18n();
  const answer = useExtensionUiStore((state) => state.answer);
  const dismiss = useExtensionUiStore((state) => state.dismiss);
  const { dialog, uiRequestId } = pending;
  // Both live in the store: the dialog now stays up until the Host has actually
  // been told, so "in flight" and "the send failed" are shared state, not a
  // component's private flag that a remount would reset mid-call.
  const sending = useExtensionUiStore((state) => state.sending.includes(uiRequestId));
  const sendError = useExtensionUiStore((state) => state.sendErrors[uiRequestId]);
  // The permission prompt's whole body arrives inside the title slot — see
  // `splitExtensionUiDialogText`.
  const { heading, body } = splitExtensionUiDialogText(dialog.title);
  // Never empty: an AlertDialog whose title renders nothing has no accessible
  // name, and a screen reader announces a modal with no idea what it asks.
  const title = heading.trim() || t('Extension request');

  const [text, setText] = useState(dialog.method === 'editor' ? (dialog.prefill ?? '') : '');

  const submit = (value: unknown) => {
    if (sending) return;
    void answer(uiRequestId, value);
  };

  const cancel = () => {
    if (sending) return;
    void dismiss(uiRequestId);
  };

  return (
    <AlertDialog open onOpenChange={(next) => !next && cancel()}>
      <AlertDialogPopup className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {dialog.method === 'confirm' && dialog.message ? (
            <AlertDialogDescription className="whitespace-pre-wrap">
              {dialog.message}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>

        {/*
         * Only when there IS a queue. One dialog at a time is the rule (see
         * `currentExtensionUiDialog`), so without this the user has no way to
         * know that answering opens another one rather than returning to the
         * chat.
         */}
        {total > 1 ? (
          <p className="px-6 pb-1 text-meta text-muted-foreground">
            {t('Request')} {position}/{total}
          </p>
        ) : null}

        {/*
         * Monospace and pre-wrapped: this body is laid out by the extension for
         * a terminal (aligned labels, wrapped commands), so a proportional font
         * would break the alignment it was rendered with. Scrollable because a
         * bash approval can list many paths, and a prompt that overflows the
         * viewport would put its own buttons out of reach.
         */}
        {body ? (
          <div className="px-6 pb-2">
            <Ident
              // `Ident` rather than a raw `font-mono` (D25 §2.5: the optical
              // compensation lives in one place) and rather than `CodeBlock`
              // (this is a rendered label/value listing, not source — syntax
              // highlighting it would assert a language it does not have).
              // `whitespace-pre-wrap` keeps the alignment the extension laid out
              // for a terminal; scrollable because a bash approval can list many
              // paths, and a prompt that overflows would put its own buttons out
              // of reach.
              className="block max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-muted-foreground"
            >
              {body}
            </Ident>
          </div>
        ) : null}

        {dialog.method === 'select' ? (
          // `role="group"` with a name, because these options are MUTUALLY
          // EXCLUSIVE and a bare stack of buttons says nothing about that: a
          // screen reader would read four unrelated commands rather than one
          // question with four answers. Not a radiogroup — picking an option
          // here submits immediately, it does not set a value the user then
          // confirms, and announcing them as radios would promise a state that
          // does not exist.
          <div role="group" aria-label={title} className="grid gap-1 px-6 pb-2">
            {dialog.options.map((option, index) => (
              <Button
                // Options are plain strings and MAY repeat (two tools with the
                // same name in a permission prompt), so the index is the only
                // stable key here.
                key={`${index}-${option}`}
                type="button"
                variant="outline"
                size="sm"
                // The project's own control rather than a hand-rolled button:
                // focus ring, disabled treatment and hover states then match
                // every other button in the app instead of approximating them.
                className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
                disabled={sending}
                autoFocus={index === 0}
                onClick={() => submit(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : null}

        {dialog.method === 'input' ? (
          <div className="px-6 pb-2">
            <Input
              autoFocus
              value={text}
              placeholder={dialog.placeholder ?? ''}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit(text);
                }
              }}
            />
          </div>
        ) : null}

        {dialog.method === 'editor' ? (
          <div className="px-6 pb-2">
            <Textarea
              autoFocus
              rows={8}
              value={text}
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        ) : null}

        {/*
         * The send failed and the dialog is STILL UP on purpose: the Host never
         * heard the answer, so its own dialog is still parked and pressing again
         * is a real retry. `role="alert"` because this appears after the user
         * acted and is the only sign the action did not land.
         */}
        {sendError ? (
          <p role="alert" className="px-6 pb-2 text-meta text-destructive">
            {t('Could not send your answer. Please try again.')} {sendError}
          </p>
        ) : null}

        <AlertDialogFooter className="gap-2 sm:gap-2">
          {/*
           * Cancel is present on every method, `select` included: a picker with
           * no way out would trap the user until the extension's own timeout,
           * and some extensions set none.
           */}
          <Button variant="outline" size="sm" disabled={sending} onClick={cancel}>
            {t('Cancel')}
          </Button>
          {dialog.method === 'confirm' ? (
            <Button size="sm" disabled={sending} onClick={() => submit(true)}>
              {t('Confirm')}
            </Button>
          ) : null}
          {dialog.method === 'input' || dialog.method === 'editor' ? (
            <Button size="sm" disabled={sending} onClick={() => submit(text)}>
              {t('Submit')}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
