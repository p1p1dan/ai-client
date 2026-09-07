import type { Announcement, AnnouncementSeverity } from '@shared/announcements';
import { AlertTriangle, Info, Megaphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const SEVERITY_ICON: Record<AnnouncementSeverity, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertTriangle,
};

const SEVERITY_CLASS: Record<AnnouncementSeverity, string> = {
  info: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive',
};

/**
 * F09 — the announcement dialog, shown automatically once per launch and
 * reopenable from the bell.
 *
 * ## One dialog, a list inside it
 *
 * The spec asks for multiple announcements "or at least room to grow". A list
 * inside one dialog is that room, and it is also the only shape that behaves
 * when the service publishes two things at once: a queue of modals would make
 * the second one appear the instant the first is dismissed, which reads as the
 * dialog refusing to close.
 *
 * ## Body text is printed, never interpreted
 *
 * `whitespace-pre-wrap` on a plain string. `parseAnnouncements` already carries
 * the body as text and caps its length; rendering it as markdown or HTML would
 * mean interpreting remote content inside the app's own chrome, which is the
 * one thing an announcement channel must not do. `break-words` is what keeps a
 * long unbroken URL from widening the dialog past the window.
 */
export function AnnouncementDialog({
  announcements,
  open,
  onOpenChange,
}: {
  announcements: readonly Announcement[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  if (announcements.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="size-4 shrink-0" />
            {t('Announcements')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('Messages from the service operator.')}
          </DialogDescription>
        </DialogHeader>
        {/* Capped rather than free-growing: a long announcement must scroll
            inside the dialog instead of pushing its footer off-screen, which
            would take the only close button with it. */}
        <ScrollArea className="max-h-[50vh]">
          <div className="flex flex-col gap-4 pr-3">
            {announcements.map((announcement, index) => {
              const Icon = SEVERITY_ICON[announcement.severity];
              return (
                <div key={announcement.id} className="flex flex-col gap-1.5">
                  {index > 0 && <Separator className="mb-2" />}
                  <div className="flex items-start gap-2">
                    <Icon
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        SEVERITY_CLASS[announcement.severity]
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{announcement.title}</div>
                      {announcement.publishedAt && (
                        <div className="text-meta text-muted-foreground">
                          {announcement.publishedAt}
                        </div>
                      )}
                    </div>
                  </div>
                  {announcement.body && (
                    <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
                      {announcement.body}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
        <DialogFooter variant="bare">
          <Button onClick={() => onOpenChange(false)}>{t('Got it')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
