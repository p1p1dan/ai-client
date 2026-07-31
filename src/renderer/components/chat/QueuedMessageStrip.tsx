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
 */
import { Pencil, X } from 'lucide-react';
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
  /** X — remove/discard (decision 5.3). */
  onRemove: (entryId: string) => void;
}

export function QueuedMessageStrip({ model, onResume, onEdit, onRemove }: QueuedMessageStripProps) {
  const { t } = useI18n();

  if (!model.visible) return null;

  return (
    // Wrapper geometry lives in middleColumnLayout (F-A10): `mb-2` is this
    // strip's whole share of the 8px band above the composer card.
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
        <QueueEntryRow key={entry.id} entry={entry} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </div>
  );
}

function QueueEntryRow({
  entry,
  onEdit,
  onRemove,
}: {
  entry: QueueStripEntryModel;
  onEdit: (entryId: string) => void;
  onRemove: (entryId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(entry.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit(entry.id);
        }
      }}
      className="flex h-7 items-center gap-1.5 rounded-sm border border-border bg-muted/50 px-2 text-meta"
    >
      <span className="shrink-0 tabular-nums text-muted-foreground">{entry.index}</span>
      <span className="min-w-0 flex-1 truncate" title={entry.preview}>
        {entry.preview}
      </span>
      {entry.attachmentCount > 0 && (
        <span className="shrink-0 text-muted-foreground">
          {entry.attachmentCount} file{entry.attachmentCount > 1 ? 's' : ''}
        </span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit(entry.id);
        }}
        aria-label="Edit queued message"
        className={ICON_BUTTON_CLASS}
      >
        <Pencil className="size-3" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(entry.id);
        }}
        aria-label="Remove queued message"
        className={ICON_BUTTON_CLASS}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
