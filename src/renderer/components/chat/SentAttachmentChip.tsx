import { FileText, Image as ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ImagePreview } from '@/components/files/ImagePreview';
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessageAttachment } from '@/stores/chatSessions';
import { hasSentImagePreview, loadSentAttachment } from './sentAttachmentPreview';

/**
 * One attachment of a sent message, under its bubble's text.
 *
 * A file, or an image the store cannot give back (a Claude SDK chat, an older
 * record, a missing object), is the read-only chip it always was: icon and
 * name. A DSH image with its store reference (issue #26 item 6) is a
 * thumbnail; a click opens it in a dialog with `files/ImagePreview`'s zoom.
 */
export function SentAttachmentChip({
  sessionId,
  attachment,
  ink,
}: {
  sessionId: string;
  attachment: ChatMessageAttachment;
  /** The bubble's ink: greyed while the message awaits delivery. */
  ink: string;
}) {
  if (hasSentImagePreview(attachment)) {
    return <SentImageThumbnail sessionId={sessionId} attachment={attachment} ink={ink} />;
  }
  return <IconChip attachment={attachment} ink={ink} />;
}

function IconChip({ attachment, ink }: { attachment: ChatMessageAttachment; ink: string }) {
  const name = attachment.name ?? attachment.mediaType;
  return (
    <span
      data-slot="sent-attachment-chip"
      // Design system v2 §1 rule 1: a tag inside the tinted bubble is one step
      // deeper fill, no edge.
      className={cn(
        'inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-xs bg-fill-ghost-selected px-1.5 text-small',
        ink
      )}
    >
      {attachment.kind === 'image' ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
    </span>
  );
}

function SentImageThumbnail({
  sessionId,
  attachment,
  ink,
}: {
  sessionId: string;
  attachment: ChatMessageAttachment;
  ink: string;
}) {
  const { t } = useI18n();
  // `undefined` while loading, `null` once it is known not to load.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const attachmentId = attachment.attachmentId as string;

  useEffect(() => {
    let cancelled = false;
    setUrl(undefined);
    void loadSentAttachment({ sessionId, attachmentId }).then((loaded) => {
      if (!cancelled) setUrl(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attachmentId]);

  if (url === null) return <IconChip attachment={attachment} ink={ink} />;
  const name = attachment.name ?? t('Image');
  return (
    <>
      <button
        type="button"
        data-slot="sent-image-thumbnail"
        // A fixed tile, so the thumbnail arriving changes nothing around it.
        className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-fill-ghost-selected focus-ring"
        title={name}
        aria-label={t('Preview image {{name}}', { name })}
        disabled={url === undefined}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
        )}
      </button>
      {url && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup className="max-w-4xl">
            <DialogHeader>
              <DialogTitle className="truncate">{name}</DialogTitle>
            </DialogHeader>
            {/* Manual px-6 instead of DialogPanel: ImagePreview pans and zooms
                inside a fixed height, which a DialogPanel scroll area would fight. */}
            <div className="px-6 pb-6">
              <div className="h-[70vh] min-h-0 overflow-hidden rounded-md border border-border-soft">
                <ImagePreview path={name} src={url} />
              </div>
            </div>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}
