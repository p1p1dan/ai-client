import { useEffect } from 'react';
import {
  activeModalQueueId,
  type ModalQueueId,
  releaseModalQueueSlot,
  requestModalQueueSlot,
  useModalQueueStore,
} from '@/stores/modalQueue';

/**
 * Registers `id` as wanting the shared "one self-opening dialog at a time"
 * slot (`@/stores/modalQueue`) for as long as `wantsOpen` is true, and
 * reports whether it currently holds it.
 *
 * The caller keeps its own `open` state exactly as it already does — fetch,
 * decide, remember the answer are all unaffected. It only changes what gets
 * passed to `<Dialog>`:
 *
 * ```tsx
 * const canShow = useModalQueueSlot('agentMigrationPrompt', open);
 * <Dialog open={open && canShow} onOpenChange={...}>
 * ```
 *
 * While `open` is true but `canShow` is false, the dialog is queued: nothing
 * portals, nothing paints, and it takes the slot the instant the current
 * holder releases it (closes, or unmounts).
 */
export function useModalQueueSlot(id: ModalQueueId, wantsOpen: boolean): boolean {
  useEffect(() => {
    if (!wantsOpen) return undefined;
    requestModalQueueSlot(id);
    return () => releaseModalQueueSlot(id);
  }, [id, wantsOpen]);

  return useModalQueueStore((state) => activeModalQueueId(state.wanted) === id);
}
