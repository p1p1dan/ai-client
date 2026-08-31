import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { useExtensionUiStore } from '@/stores/extensionUi';
import {
  currentExtensionUiDialogForSession,
  currentUnscopedExtensionUiDialog,
  type ExtensionUiPendingDialog,
  extensionUiPendingCountForSession,
  splitExtensionUiDialogText,
} from './extensionUiModel';

/**
 * Session-less bind requests are exceptional, but they still must not restore
 * the removed window-wide modal. They use the same non-modal dock as ordinary
 * session requests and appear next to the Composer until the bridge settles.
 */
export function ExtensionUiDialog() {
  const pending = useExtensionUiStore((state) => state.pending);
  const request = currentUnscopedExtensionUiDialog({ pending });
  const total = pending.filter((item) => item.sessionId == null).length;
  return request ? (
    <ExtensionUiDock key={request.uiRequestId} pending={request} total={total} />
  ) : null;
}

/**
 * T08-b — blocking Extension UI rendered inside the conversation that owns it.
 * Each session has its own FIFO; background requests remain visible only as a
 * sidebar badge until that session becomes active.
 */
export function ExtensionUiInlineDock({ sessionId }: { sessionId: string | null }) {
  const pending = useExtensionUiStore((state) => state.pending);
  const request = currentExtensionUiDialogForSession({ pending }, sessionId);
  const total = extensionUiPendingCountForSession(pending, sessionId);
  return request ? (
    <ExtensionUiDock key={request.uiRequestId} pending={request} total={total} />
  ) : null;
}

function ExtensionUiDock({ pending, total }: { pending: ExtensionUiPendingDialog; total: number }) {
  const { dialog } = pending;
  const { heading } = splitExtensionUiDialogText(dialog.title);
  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto w-full max-w-reading">
        <section
          aria-label={heading.trim() || 'Extension request'}
          className="rounded-md border border-warning/30 bg-warning/8"
        >
          <ExtensionUiRequestContent pending={pending} position={1} total={total} />
        </section>
      </div>
    </div>
  );
}

/**
 * Container-independent request content. The bridge/store semantics remain the
 * same after removing the modal: keyed drafts, acknowledged close,
 * retry-after-IPC-failure and dismissal fallback all live here once.
 */
function ExtensionUiRequestContent({
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
  const sending = useExtensionUiStore((state) => state.sending.includes(uiRequestId));
  const sendError = useExtensionUiStore((state) => state.sendErrors[uiRequestId]);
  const { heading, body } = splitExtensionUiDialogText(dialog.title);
  const title = heading.trim() || t('Extension request');
  const [text, setText] = useState(dialog.method === 'editor' ? (dialog.prefill ?? '') : '');

  const submit = (value: unknown) => {
    if (!sending) void answer(uiRequestId, value);
  };
  const cancel = () => {
    if (!sending) void dismiss(uiRequestId);
  };

  return (
    <>
      <div className="flex items-start gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui font-semibold text-foreground">{title}</h2>
          {dialog.method === 'confirm' && dialog.message ? (
            <p className="mt-1 whitespace-pre-wrap text-meta text-muted-foreground">
              {dialog.message}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Cancel')}
          title={t('Cancel')}
          disabled={sending}
          onClick={cancel}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {total > 1 ? (
        <p className="px-3 pb-1 text-meta text-muted-foreground tabular-nums">
          {t('Request')} {position}/{total}
        </p>
      ) : null}

      {body ? (
        <div className="px-3 pb-2">
          <Ident className="block max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-muted-foreground">
            {body}
          </Ident>
        </div>
      ) : null}

      {dialog.method === 'select' ? (
        <div role="group" aria-label={title} className="grid gap-1 px-3 pb-2">
          {dialog.options.map((option, index) => (
            <Button
              key={`${index}-${option}`}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left normal-case"
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
        <div className="px-3 pb-2">
          <Input
            autoFocus
            value={text}
            placeholder={dialog.placeholder ?? ''}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit(text);
              }
            }}
          />
        </div>
      ) : null}

      {dialog.method === 'editor' ? (
        <div className="px-3 pb-2">
          <Textarea
            autoFocus
            rows={8}
            value={text}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      ) : null}

      {sendError ? (
        <p role="alert" className="px-3 pb-2 text-meta text-destructive">
          {t('Could not send your answer. Please try again.')} {sendError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 px-3 pb-3">
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
      </div>
    </>
  );
}
