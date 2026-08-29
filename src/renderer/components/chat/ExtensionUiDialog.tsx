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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { currentExtensionUiDialog, type ExtensionUiPendingDialog } from './extensionUiModel';

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
  return dialog ? <ExtensionUiDialogBody key={dialog.uiRequestId} pending={dialog} /> : null;
}

function ExtensionUiDialogBody({ pending }: { pending: ExtensionUiPendingDialog }) {
  const { t } = useI18n();
  const answer = useExtensionUiStore((state) => state.answer);
  const dismiss = useExtensionUiStore((state) => state.dismiss);
  const { dialog, uiRequestId } = pending;

  const [text, setText] = useState(dialog.method === 'editor' ? (dialog.prefill ?? '') : '');
  // Guards the window between the click and the store update: without it a
  // double-click sends two answers, and the second is a wasted IPC round trip
  // the Host refuses anyway.
  const [sending, setSending] = useState(false);

  const submit = (value: unknown) => {
    if (sending) return;
    setSending(true);
    void answer(uiRequestId, value);
  };

  const cancel = () => {
    if (sending) return;
    setSending(true);
    void dismiss(uiRequestId);
  };

  return (
    <AlertDialog open onOpenChange={(next) => !next && cancel()}>
      <AlertDialogPopup className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
          {dialog.method === 'confirm' && dialog.message ? (
            <AlertDialogDescription className="whitespace-pre-wrap">
              {dialog.message}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>

        {dialog.method === 'select' ? (
          <div className="grid gap-1 px-6 pb-2">
            {dialog.options.map((option, index) => (
              <button
                // Options are plain strings and MAY repeat (two tools with the
                // same name in a permission prompt), so the index is the only
                // stable key here.
                key={`${index}-${option}`}
                type="button"
                disabled={sending}
                className="rounded-md border border-border/50 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 disabled:opacity-50"
                onClick={() => submit(option)}
              >
                {option}
              </button>
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
