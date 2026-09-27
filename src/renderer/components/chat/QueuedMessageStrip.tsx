/**
 * T-19 batch 3 — pure view for the message-queue strip.
 *
 * Renders exactly what `deriveQueueStripModel` (queueRelease.ts) computed —
 * this component makes NO judgment of its own (no `SessionRuntimeStatus`, no
 * queue reducers, no i18n lookups beyond the static button label). The
 * icon/size/truncation language is copied from `ChatComposer.tsx`'s
 * `AttachmentChip` remove button (`:155-163`) so the two chip surfaces read
 * as one system.
 *
 * T-19 fix review (R5): the failed-row Retry/Discard variant (warning
 * border, TriangleAlert, inline Retry button) is removed here — batch 3's
 * queue-based failure tracking was reverted (see `queueRelease.ts`'s
 * header), so no entry this component ever renders can have `failed: true`
 * in production. `QueueStripEntryModel.failed`/`failureMessage` stay defined
 * in the pure layer as a dormant field for a future T-19b; this view simply
 * does not consume them anymore.
 *
 * Decision 046 rule 4: a disabled control must not turn a click into another
 * action. Disabled buttons here are `pointer-events: none` (the `Button` base
 * class and `ICON_BUTTON_CLASS`), so a click on one lands on whatever is under
 * it — and that used to be the row, whose click is "take back into the draft".
 * Pressing a disabled "Send now" after ending a conversation moved the message
 * out of the queue and into the composer. The row's controls therefore sit in
 * one group that swallows clicks and keys, and a disabled "Send now" says why.
 */
import { ArrowDown, ArrowUp, CornerDownRight, Pencil, X, Zap } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { queueStripWrapperClass } from './middleColumnLayout';
import type { QueueStripEntryModel, QueueStripModel } from './queueRelease';

// Copied verbatim from AttachmentChip's remove-button class (ChatComposer.tsx)
// — same 16px icon-button language for the queue strip's Pencil/X actions.
const ICON_BUTTON_CLASS =
  'flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-64';

export interface QueuedMessageStripProps {
  model: QueueStripModel;
  /** Pause row's Resume action (decision 3.4). */
  onResume: () => void;
  /** Pencil / click-row — `takeEntryIntoDraft` swap (decision 5.3). */
  onEdit: (entryId: string) => void;
  /** Exchange with the adjacent row while preserving message identity/payload. */
  onMove: (entryId: string, direction: 'up' | 'down') => void;
  /** X — remove/discard (decision 5.3). */
  onRemove: (entryId: string) => void;
  /** Zap — interrupt the running turn and send this entry next. Head row only. */
  onSendNow: (entryId: string) => void;
  /** Whether the composer can dispatch right now; `entry.canSendNow` decides WHICH row offers it. */
  sendNowDisabled?: boolean;
  /** Translated reason shown as the tooltip while "Send now" is disabled. */
  sendNowDisabledReason?: string;
}

/**
 * Keeps a click or key inside the row's controls from reaching the row's own
 * "edit" handler — including a click that passed THROUGH a disabled button.
 */
function stopRowActivation(event: MouseEvent | KeyboardEvent): void {
  event.stopPropagation();
}

export function QueuedMessageStrip({
  model,
  onResume,
  onEdit,
  onMove,
  onRemove,
  onSendNow,
  sendNowDisabled,
  sendNowDisabledReason,
}: QueuedMessageStripProps) {
  const { t } = useI18n();

  if (!model.visible) return null;

  return (
    <div className={queueStripWrapperClass()}>
      {model.permissionHint && (
        <div className="flex h-6 items-center gap-2 text-meta text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{model.permissionHint}</span>
        </div>
      )}
      {model.pausedLabel && (
        <div className="flex h-6 items-center justify-between gap-2 text-meta text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{model.pausedLabel}</span>
          <button
            type="button"
            onClick={onResume}
            className="shrink-0 text-foreground underline-offset-2 hover:underline"
          >
            {t('Resume')}
          </button>
        </div>
      )}
      {model.entries.map((entry) => (
        <QueueEntryRow
          key={entry.id}
          entry={entry}
          onEdit={onEdit}
          onMove={onMove}
          onRemove={onRemove}
          onSendNow={onSendNow}
          sendNowDisabled={sendNowDisabled}
          sendNowDisabledReason={sendNowDisabledReason}
        />
      ))}
    </div>
  );
}

function QueueEntryRow({
  entry,
  onEdit,
  onMove,
  onRemove,
  onSendNow,
  sendNowDisabled,
  sendNowDisabledReason,
}: {
  entry: QueueStripEntryModel;
  onEdit: (entryId: string) => void;
  onMove: (entryId: string, direction: 'up' | 'down') => void;
  onRemove: (entryId: string) => void;
  onSendNow: (entryId: string) => void;
  sendNowDisabled?: boolean;
  sendNowDisabledReason?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(entry.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit(entry.id);
        }
      }}
      className="flex h-7 items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-2 text-meta"
    >
      <span className="shrink-0 tabular-nums text-muted-foreground">{entry.index}</span>
      {entry.interjection && (
        // Ctrl+Enter rows sit mixed in with ordinary queue traffic and differ
        // only in when they deliver, so the marker is the only thing that tells
        // the user which one stopped the turn.
        <span
          className="flex shrink-0 items-center gap-1 text-muted-foreground"
          title={t('Interjected with Ctrl+Enter — sent at the next turn boundary')}
        >
          <CornerDownRight className="size-3" />
          {t('Next')}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={entry.preview}>
        {entry.preview}
      </span>
      {entry.attachmentCount > 0 && (
        <span className="shrink-0 text-muted-foreground">
          {entry.attachmentCount} file{entry.attachmentCount > 1 ? 's' : ''}
        </span>
      )}
      <div
        className="flex shrink-0 items-center gap-1.5"
        data-testid="queue-row-actions"
        onClick={stopRowActivation}
        onKeyDown={stopRowActivation}
      >
        {entry.canSendNow && (
          // The wrapper, not the button, carries the disabled tooltip: a
          // disabled button receives no pointer events, so its own title
          // never shows.
          <span
            className="flex shrink-0"
            data-testid="queue-send-now"
            title={sendNowDisabled ? sendNowDisabledReason : undefined}
          >
            <Button
              size="xs"
              variant="ghost"
              disabled={sendNowDisabled}
              title={
                sendNowDisabled ? sendNowDisabledReason : t('Send now — interrupt the running turn')
              }
              onClick={() => onSendNow(entry.id)}
            >
              <Zap className="size-3" />
              {t('Send now')}
            </Button>
          </span>
        )}
        <button
          type="button"
          onClick={() => onMove(entry.id, 'up')}
          disabled={!entry.canMoveUp}
          aria-label={t('Move queued message up')}
          className={ICON_BUTTON_CLASS}
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => onMove(entry.id, 'down')}
          disabled={!entry.canMoveDown}
          aria-label={t('Move queued message down')}
          className={ICON_BUTTON_CLASS}
        >
          <ArrowDown className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => onEdit(entry.id)}
          aria-label={t('Edit queued message')}
          className={ICON_BUTTON_CLASS}
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(entry.id)}
          aria-label={t('Remove queued message')}
          className={ICON_BUTTON_CLASS}
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
