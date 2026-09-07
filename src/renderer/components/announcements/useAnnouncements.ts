import {
  type Announcement,
  type AnnouncementsResult,
  shouldOpenAnnouncementsOnStartup,
  unreadAnnouncementIds,
} from '@shared/announcements';
import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY: AnnouncementsResult = {
  announcements: [],
  source: 'unavailable',
  fetchedAt: null,
  readIds: [],
};

export interface UseAnnouncementsResult {
  announcements: Announcement[];
  unreadCount: number;
  /** The startup dialog's open state, and the bell's manual open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Record everything currently listed as seen. */
  markAllRead: () => void;
}

/**
 * F09 — the renderer half of startup announcements.
 *
 * ## Why the startup fetch is fire-and-forget
 *
 * The one hard requirement is that this cannot delay or block the main
 * interface. So: the effect starts a `refresh()` and never awaits it on any
 * path the shell depends on, the IPC layer never rejects (see
 * `main/ipc/announcements.ts`), and a failure simply leaves the hook with the
 * empty result it started with. Nothing here has an error branch to render,
 * because "the message board is offline" is not news the user asked for.
 *
 * The snapshot is read FIRST, from disk, so an offline launch still shows the
 * cached message immediately instead of waiting out a doomed request.
 *
 * ## Why the dialog opens once per launch, not once per change
 *
 * `openedRef` latches. The product ruling is "every launch, automatically" —
 * one launch, one automatic open. Without the latch a late `refresh()` landing
 * after the user has already dismissed the dialog would reopen it on top of
 * whatever they moved on to, which reads as a bug however correct the rule
 * behind it is. Re-opening by hand, from the bell, is always available.
 */
export function useAnnouncements(): UseAnnouncementsResult {
  const [result, setResult] = useState<AnnouncementsResult>(EMPTY);
  const [open, setOpen] = useState(false);
  const openedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: AnnouncementsResult) => {
      if (cancelled) return;
      setResult(next);
      if (openedRef.current) return;
      if (!shouldOpenAnnouncementsOnStartup(next)) return;
      openedRef.current = true;
      setOpen(true);
    };
    // Disk first, network second. Both go through the same `apply`, so a cache
    // hit can open the dialog without waiting for a request that may time out.
    void window.electronAPI.announcements.get().then(apply);
    void window.electronAPI.announcements.refresh().then(apply);
    return () => {
      cancelled = true;
    };
  }, []);

  const markAllRead = useCallback(() => {
    const unread = unreadAnnouncementIds(result.announcements, result.readIds);
    if (unread.length === 0) return;
    void window.electronAPI.announcements.markRead(unread).then(setResult);
  }, [result.announcements, result.readIds]);

  return {
    announcements: result.announcements,
    unreadCount: unreadAnnouncementIds(result.announcements, result.readIds).length,
    open,
    setOpen,
    markAllRead,
  };
}
