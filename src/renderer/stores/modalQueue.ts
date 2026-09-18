import { create } from 'zustand';

/**
 * 2026-09-18 field report: the startup announcement and the Pi-setup
 * migration offer both auto-open on the same launch, land on the same
 * MODAL_CONTENT/MODAL_BACKDROP tier (`@/lib/z-index.ts` only splits "base
 * modal" from "nested modal" — a dialog opened from inside another dialog —
 * and has no concept of two independent top-level modals competing for the
 * same launch), and whichever painted second covered the other's own
 * buttons. The announcement became permanently undismissable: its "Got it"
 * button sat directly under the migration dialog's list rows.
 *
 * This store is the fix: every self-opening top-level dialog asks for the one
 * shared slot instead of deciding on its own that "I have something to show"
 * means "render now". At most one holds the slot at a time; the rest wait and
 * take over, in a fixed priority order, the moment the holder lets go.
 *
 * Deliberately NOT for every `Dialog` in the app. A dialog the user just
 * opened by pressing something (Settings, "Add repository", the sign-in
 * confirmation, a remote SSH auth prompt) is a direct answer to a gesture the
 * user just made, so it stacking above whatever background dialog is idling
 * behind it reads as normal, not as noise — those keep using `Dialog`
 * directly. This queue is only for dialogs that open BY THEMSELVES, unasked,
 * off a background check.
 */

/**
 * Lower number wins when more than one wants the slot at the same time.
 *
 * Order, and why: the server's own announcement outranks anything local — it
 * is the one channel this app has for "read this before anything else". The
 * migration offer outranks the update-ready nag because acting on it can
 * unblock a user who cannot chat at all yet, while an update can always be
 * started later from the small pill `UpdateNotification` leaves on screen
 * even while its own dialog is not the active one.
 */
export const MODAL_QUEUE_PRIORITY = {
  announcement: 0,
  agentMigrationPrompt: 1,
  updateNotification: 2,
} as const;

export type ModalQueueId = keyof typeof MODAL_QUEUE_PRIORITY;

interface ModalQueueState {
  /** Ids currently asking for the slot. Presence means "wants it", not "has it". */
  wanted: Partial<Record<ModalQueueId, true>>;
}

export const useModalQueueStore = create<ModalQueueState>(() => ({
  wanted: {},
}));

/** The id currently allowed to actually show, or `null` if nobody wants the slot. */
export function activeModalQueueId(
  wanted: Partial<Record<ModalQueueId, true>>
): ModalQueueId | null {
  let best: ModalQueueId | null = null;
  for (const id of Object.keys(wanted) as ModalQueueId[]) {
    if (best === null || MODAL_QUEUE_PRIORITY[id] < MODAL_QUEUE_PRIORITY[best]) {
      best = id;
    }
  }
  return best;
}

/** Idempotent: asking twice while already queued is a no-op, not a second entry. */
export function requestModalQueueSlot(id: ModalQueueId): void {
  const { wanted } = useModalQueueStore.getState();
  if (wanted[id]) return;
  useModalQueueStore.setState({ wanted: { ...wanted, [id]: true } });
}

/** Idempotent: releasing an id that never asked (or already let go) is a no-op. */
export function releaseModalQueueSlot(id: ModalQueueId): void {
  const { wanted } = useModalQueueStore.getState();
  if (!wanted[id]) return;
  const next = { ...wanted };
  delete next[id];
  useModalQueueStore.setState({ wanted: next });
}

/** Test-only: module state persists across tests otherwise. */
export function resetModalQueueForTests(): void {
  useModalQueueStore.setState({ wanted: {} });
}
