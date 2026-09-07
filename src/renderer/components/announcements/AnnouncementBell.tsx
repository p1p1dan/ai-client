import { Bell } from 'lucide-react';
import { useEffect } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { AnnouncementDialog } from './AnnouncementDialog';
import { useAnnouncements } from './useAnnouncements';

/**
 * F09 — the bell, and the dialog it owns.
 *
 * ## Why the bell and the dialog are one component
 *
 * The startup auto-open and the manual open are the same dialog with the same
 * list, and `useAnnouncements` already holds both. Splitting them would mean
 * lifting that state into whatever renders them and threading it back down,
 * for no gain — nothing else in the app needs to know about announcements.
 *
 * ## Placement
 *
 * The left dock's footer, beside the account pill, on every platform (user
 * ruling, 2026-09-07). The field request said "where the `...` button was", but
 * that button lives in `WindowTitleBar`, which does not render on macOS at all
 * (native title bar) — so the literal reading would have left one of the three
 * shipped platforms with no way to re-read an announcement after dismissing it.
 * The footer is the one place that exists on all three, and it is already where
 * D07/D08 moved the app-level chrome the title bar used to carry.
 *
 * ## The unread mark is a dot, not a count
 *
 * There is no useful action attached to "3 unread" that "unread" does not
 * already prompt, and the footer row is 24px tall with an email address and a
 * cost figure already competing for it.
 *
 * Everything on screen is marked read from ONE effect keyed on `open`, rather
 * than from the click handler. The dialog has two ways to open — the bell, and
 * the automatic one on launch — and a click-handler version would mark only the
 * first, leaving the dot lit next to a message the user demonstrably just read.
 */
export function AnnouncementBell() {
  const { t } = useI18n();
  const { announcements, unreadCount, open, setOpen, markAllRead } = useAnnouncements();

  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  // Nothing to announce: no button. A permanently dead bell would be a control
  // for a capability that is not there — the same rule the composer's menu
  // header states about inventing affordances.
  if (announcements.length === 0) return null;

  const label = unreadCount > 0 ? t('Announcements (unread)') : t('Announcements');

  return (
    <>
      <button
        type="button"
        className={cn(
          'relative flex size-6 shrink-0 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors hover:bg-hover hover:text-foreground'
        )}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <Bell className="size-3.5" />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent-primary"
          />
        )}
      </button>
      <AnnouncementDialog announcements={announcements} open={open} onOpenChange={setOpen} />
    </>
  );
}
